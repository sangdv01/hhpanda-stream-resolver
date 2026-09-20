const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const http = require('http');
const crypto = require('crypto');
const resolver = require('./resolve');
const yan = require('./yanhh3d');
const xoiche = require('./xoiche');

const yanStreamMap = new Map();

// Dọn dẹp cache stream YanHH3D sau mỗi 30 phút
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of yanStreamMap.entries()) {
    if (now - item.createdAt > 3 * 3600 * 1000) {
      yanStreamMap.delete(id);
    }
  }
}, 30 * 60 * 1000);

let sharedBrowser = null;
let sharedBrowserPromise = null;

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (sharedBrowserPromise) {
    return sharedBrowserPromise;
  }

  sharedBrowserPromise = (async () => {
    console.log('[browser] launching shared Chromium...');

    const started = Date.now();

    try {
      const browser = await resolver.createStreamfreeBrowser();

      sharedBrowser = browser;

      console.log(
        `[browser] shared Chromium ready in ${Date.now() - started}ms`
      );

      return browser;
    } catch (error) {
      console.error(
        '[browser] shared Chromium FAILED:',
        error.message
      );

      throw error;
    } finally {
      sharedBrowserPromise = null;
    }
  })();

  return sharedBrowserPromise;
}

const HHPANDA = 'https://hhpanda.st';

const builder = new addonBuilder({
  id: 'community.hhpanda',
  version: '1.3.5',
  name: 'YanHH3D & HHPanda',
  logo: 'https://yanhh3d.men/storage/settings/January2026/logo.png',
  description: 'Hoạt hình Trung Quốc 3D • YanHH3D & HHPanda (1080P & 4K • Thuyết Minh & Vietsub)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  catalogs: [
    {
      type: 'series',
      id: 'yanhh3d',
      name: 'YanHH3D (Hoạt Hình 3D)'
    },
    {
      type: 'series',
      id: 'hhpanda',
      name: 'HHPanda (Thịnh hành)'
    }
  ]
});

function getText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function parseTrending(html) {
  const cardRegex =
    /<a\b[^>]*class=["'][^"']*\bhalim-trending-link\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;

  const cards = [];
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    cards.push(match[0]);
  }

  const movies = [];
  const seen = new Set();

  for (const card of cards) {
    const hrefMatch = card.match(
      /<a\b[^>]*href=["']([^"']+)["']/i
    );

    if (!hrefMatch) continue;

    const href = new URL(hrefMatch[1], HHPANDA).href;

    const nameMatch = card.match(
      /class=["'][^"']*\bhalim-trending-title-text\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i
    );

    const posterMatch = card.match(
      /<img\b[^>]*src=["']([^"']+)["']/i
    );

    const ratingMatch = card.match(
      /class=["'][^"']*\bhalim-trending-rating-value\b[^"']*["'][^>]*>\s*([^<\s]+)\s*</i
    );

    const numberMatch = card.match(
      /class=["'][^"']*\bhalim-trending-number\b[^"']*["'][^>]*>\s*(\d+)/i
    );

    const name = nameMatch
      ? getText(nameMatch[1])
      : href.split('/').filter(Boolean).pop();

    if (!name || seen.has(href)) continue;

    seen.add(href);

    movies.push({
      id: href,
      name,
      poster: posterMatch
        ? new URL(posterMatch[1], HHPANDA).href
        : undefined,
      rating: ratingMatch
        ? Number(ratingMatch[1])
        : undefined,
      rank: numberMatch
        ? Number(numberMatch[1])
        : movies.length + 1
    });
  }

  movies.sort((a, b) => a.rank - b.rank);

  console.log('[catalog] Trending cards:', movies.length);

  for (const movie of movies) {
    console.log(
      `[catalog] #${movie.rank} ${movie.name} -> ${movie.id}`
    );
  }

  if (!movies.length) {
    throw new Error('Không tìm thấy card Trending HHPanda');
  }

  return movies;
}

async function fetchCatalog() {
  console.log('[catalog] fetching HHPanda Trending...');

  const html = await fetchHTML(HHPANDA);

  return parseTrending(html);
}

async function fetchEpisodes(seriesUrl) {
  console.log('[meta] fetching episodes:', seriesUrl);

  const html = await fetchHTML(seriesUrl);

  const regex =
    /<a\b[^>]*href=["']([^"']*\/watch-[^"']+\/tap-[^"']+-sv2\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const episodes = [];
  const seen = new Set();

  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = new URL(match[1], seriesUrl).href;
    const text = getText(match[2]);

    const episodeMatch =
      href.match(/\/tap-(\d+(?:-\d+)?)(?:-movie)?-sv2\.html$/i);

    if (!episodeMatch) continue;

    const episodeKey = episodeMatch[1];

    if (seen.has(episodeKey)) continue;
    seen.add(episodeKey);

    const episodeNumber = episodeKey.includes('-')
      ? Number(episodeKey.replace('-', '.'))
      : Number(episodeKey);

    episodes.push({
      id: href,
      title: text || `Tập ${episodeKey.replace('-', '.')}`,
      season: 1,
      episode: episodeNumber
    });
  }

  episodes.sort((a, b) => a.episode - b.episode);

  console.log(
    '[meta] HHPanda Thuyết Minh episodes:',
    episodes.length
  );

  if (!episodes.length) {
    throw new Error(
      `Không tìm thấy episode Thuyết Minh (sv2): ${seriesUrl}`
    );
  }

  return episodes;
}

async function fetchMeta(seriesUrl) {
  const html = await fetchHTML(seriesUrl);

  const titleMatch =
    html.match(
      /<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
    ) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const title = titleMatch
    ? getText(titleMatch[1])
    : seriesUrl.split('/').filter(Boolean).pop();

  const posterMatch =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<img\b[^>]*class=["'][^"']*film-poster-img[^"']*["'][^>]*src=["']([^"']+)["']/i
    );

  const descriptionMatch =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    );

  const yearMatch =
    html.match(/(?:Năm|Year)[^0-9]{0,30}(20\d{2})/i);

  const poster = posterMatch
    ? new URL(posterMatch[1], seriesUrl).href
    : undefined;

  const episodes = await fetchEpisodes(seriesUrl);

  return {
    id: seriesUrl,
    type: 'series',
    name: title,
    poster,
    background: poster,
    logo: poster,
    description: descriptionMatch
      ? descriptionMatch[1]
      : `${title} • Hoạt hình Trung Quốc 3D • Thuyết Minh`,
    releaseInfo: yearMatch ? yearMatch[1] : undefined,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    genres: ['Hoạt Hình', 'Trung Quốc', '3D'],
    videos: episodes
  };
}

builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`[catalog] ${type} ${id}`);

  if (type !== 'series') {
    return { metas: [] };
  }

  // Danh mục YanHH3D
  if (id === 'yanhh3d') {
    try {
      const movies = await yan.fetchTrendingYan();
      return {
        metas: movies.map(movie => ({
          id: movie.id,
          type: 'series',
          name: movie.name,
          poster: movie.poster,
          logo: movie.poster,
          background: movie.poster,
          description: movie.description
        }))
      };
    } catch (error) {
      console.error('[catalog yanhh3d] FAILED:', error.message);
      return { metas: [] };
    }
  }

  // Danh mục HHPanda
  if (id === 'hhpanda') {
    try {
      const movies = await fetchCatalog();
      return {
        metas: movies.map(movie => ({
          id: movie.id,
          type: 'series',
          name: movie.name,
          poster: movie.poster,
          logo: movie.poster,
          background: movie.poster,
          description: movie.rating
            ? `HHPanda • Đang thịnh hành • Rating ${movie.rating}`
            : 'HHPanda • Đang thịnh hành'
        }))
      };
    } catch (error) {
      console.error('[catalog hhpanda] FAILED:', error.message);
      return { metas: [] };
    }
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  id = decodeURIComponent(id).replace(/^https?:\/+(?=[^/])/, 'https://');
  console.log(`[meta] ${type} ${id}`);

  if (type !== 'series') {
    return { meta: null };
  }

  try {
    if (yan.isYanId(id)) {
      const meta = await yan.fetchMetaYan(id);
      return { meta };
    } else {
      const meta = await fetchMeta(id);
      return { meta };
    }
  } catch (error) {
    console.error('[meta] FAILED:', error.message);

    return {
      meta: {
        id,
        type: 'series',
        name: id.split('/').filter(Boolean).pop()
      }
    };
  }
});

const gatewayHandlers = new Map();

builder.defineStreamHandler(async ({ type, id }) => {
  id = decodeURIComponent(id).replace(/^https?:\/+(?=[^/])/, 'https://');

  console.log(`[stream] ${type} ${id}`);

  if (type !== 'series') {
    return { streams: [] };
  }

  const PORT = Number(process.env.PORT || 7000);
  const publicBaseUrl =
    process.env.AZURE_PUBLIC_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : `http://0.0.0.0:${PORT}`);

  // NGUỒN 1: YanHH3D (1080P & 4K • Thuyết Minh & Vietsub)
  if (yan.isYanId(id)) {
    try {
      const yanStreams = await yan.resolveYanStreams(id);
      const outputStreams = [];

      for (const s of yanStreams) {
        const streamId = crypto.randomUUID();
        yanStreamMap.set(streamId, {
          playlistUrl: s.playlistUrl,
          createdAt: Date.now()
        });

        outputStreams.push({
          name: s.name,
          title: s.title,
          url: `${publicBaseUrl}/gateway/yan/${streamId}/stream.m3u8`,
          behaviorHints: {
            notWebReady: true
          }
        });
      }

      return { streams: outputStreams };
    } catch (err) {
      console.error('[stream yanhh3d] FAILED:', err.message);
      return { streams: [] };
    }
  }

  // NGUỒN 2: HHPanda (1080P • Thuyết Minh)
  let resolution = null;
  let gateway = null;

  try {
    const streamStarted = Date.now();
    const browserStarted = Date.now();
    const browser = await getSharedBrowser();

    console.log(
      `[stream] shared browser ready in ${Date.now() - browserStarted}ms`
    );

    const resolveStarted = Date.now();

    resolution = await resolver.resolveHHPandaEpisode(
      id,
      'pro',
      browser
    );

    console.log(
      `[stream] resolver completed in ${Date.now() - resolveStarted}ms`
    );

    console.log(
      `[stream] TOTAL resolve time: ${Date.now() - streamStarted}ms`
    );

    console.log(
      `[stream] ${resolution.mappings.length} mappings resolved`
    );

    const gatewayId = crypto.randomUUID();

    gatewayHandlers.set(
      gatewayId,
      resolver.createStreamGatewayHandler(resolution, gatewayId)
    );

    gateway = {
      server: null,
      streamUrl:
        `${publicBaseUrl}/gateway/${gatewayId}/stream.m3u8`
    };

    console.log(
      `[stream] gateway: ${gateway.streamUrl}`
    );

    return {
      streams: [
        {
          name: '[HHPanda]\n1080P',
          title: 'HHPanda • 1080P • Thuyết Minh',
          url: gateway.streamUrl,
          behaviorHints: {
            notWebReady: true
          }
        }
      ]
    };
  } catch (error) {
    console.error('[stream hhpanda] FAILED:', error.message);

    if (gateway?.server) {
      gateway.server.close();
    }

    return {
      streams: []
    };
  }
});

const PORT = Number(process.env.PORT || 7000);
const HOST =
  process.env.RENDER_EXTERNAL_HOSTNAME
    ? '0.0.0.0'
    : '0.0.0.0';

const addonRouter = getRouter(builder.getInterface());

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || '0.0.0.0'}`
    );

    // ROUTE CHO XÔI CHÈ LIVE:
    if (requestUrl.pathname.startsWith('/xoiche')) {
      return await xoiche.handleRequest(req, res, requestUrl);
    }

    // ROUTE GATEWAY CHO YANHH3D:
    // 1. Phục vụ Playlist: /gateway/yan/:streamId/stream.m3u8
    const yanM3u8Match = requestUrl.pathname.match(/^\/gateway\/yan\/([^/]+)\/stream\.m3u8$/);
    if (yanM3u8Match) {
      const streamId = yanM3u8Match[1];
      const streamInfo = yanStreamMap.get(streamId);
      if (!streamInfo) {
        res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return res.end('stream not found or expired');
      }

      const publicBase =
        process.env.AZURE_PUBLIC_URL ||
        (process.env.RENDER_EXTERNAL_HOSTNAME
          ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
          : `http://${req.headers.host || '0.0.0.0'}`);

      try {
        const yanBase = await yan.getBaseUrl();
        const plRes = await fetch(streamInfo.playlistUrl, {
          headers: {
            'Referer': `${yanBase}/`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'
          }
        });

        if (!plRes.ok) {
          res.writeHead(502, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
          return res.end('upstream playlist error');
        }

        const plText = await plRes.text();
        const rewritten = plText.split(/\r?\n/).map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            return line;
          }
          try {
            const absUrl = new URL(trimmed, streamInfo.playlistUrl).href;
            const b64 = Buffer.from(absUrl).toString('base64url');
            return `${publicBase}/gateway/yan/seg/${b64}.ts`;
          } catch (e) {
            return line;
          }
        }).join('\n');

        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        });
        return res.end(rewritten);
      } catch (err) {
        console.error('[gateway yan m3u8] error:', err.message);
        res.writeHead(500, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return res.end('internal gateway error');
      }
    }

    // 2. Phục vụ Segment MPEG-TS: /gateway/yan/seg/:b64.ts (và fallback /gateway/yan/segment.ts?u=...)
    const yanSegMatch = requestUrl.pathname.match(/^\/gateway\/yan\/seg\/([^/]+)\.ts$/);
    if (yanSegMatch || requestUrl.pathname === '/gateway/yan/segment.ts') {
      let targetUrl = null;
      if (yanSegMatch) {
        try {
          targetUrl = Buffer.from(yanSegMatch[1], 'base64url').toString('utf8');
        } catch (e) {}
      } else {
        targetUrl = requestUrl.searchParams.get('u');
      }

      if (!targetUrl) {
        res.writeHead(400, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return res.end('missing target segment url');
      }

      try {
        const yanBase = await yan.getBaseUrl();
        const upstreamHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
          'Referer': `${yanBase}/`
        };

        const segRes = await fetch(targetUrl, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: upstreamHeaders
        });

        if (!segRes.ok) {
          res.writeHead(segRes.status, { 'access-control-allow-origin': '*' });
          return res.end();
        }

        const segBuf = Buffer.from(await segRes.arrayBuffer());
        const offset = yan.findTsSyncOffset(segBuf);
        const videoChunk = segBuf.slice(offset);

        res.writeHead(200, {
          'content-type': 'video/mp2t',
          'access-control-allow-origin': '*',
          'content-length': videoChunk.length,
          'cache-control': 'public, max-age=86400'
        });

        if (req.method === 'HEAD') {
          return res.end();
        }

        return res.end(videoChunk);
      } catch (err) {
        console.error('[gateway yan segment] error:', err.message);
        res.writeHead(500, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return res.end('failed to load segment');
      }
    }

    const gatewayMatch =
      requestUrl.pathname.match(
        /^\/gateway\/([^/]+)(\/.*)?$/
      );

    if (gatewayMatch) {
      const gatewayId = gatewayMatch[1];
      const gatewayHandler =
        gatewayHandlers.get(gatewayId);

      if (!gatewayHandler) {
        res.writeHead(404);
        return res.end('gateway not found');
      }

      const originalUrl = req.url;
      const gatewayPath = gatewayMatch[2] || '/';

      req.url =
        gatewayPath +
        (requestUrl.search || '');

      try {
        return await gatewayHandler(req, res);
      } finally {
        req.url = originalUrl;
      }
    }

    const routeMatch = req.url.match(/^\/(meta|stream)\/([^/]+)\/(.+)$/);
    if (routeMatch) {
      const resource = routeMatch[1];
      const type = routeMatch[2];
      const remainder = routeMatch[3];
      const [pathPart, queryString] = remainder.split('?');
      const query = queryString ? `?${queryString}` : '';

      if (pathPart.endsWith('.json')) {
        const rawId = pathPart.slice(0, -5).replace(/^https?:\/+(?=[^/])/, 'https://');
        const encodedId = encodeURIComponent(decodeURIComponent(rawId).replace(/^https?:\/+(?=[^/])/, 'https://'));
        req.url = `/${resource}/${type}/${encodedId}.json${query}`;
      }
    }

    return addonRouter(req, res, () => {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end('not found');
      }
    });
  } catch (error) {
    console.error('[server] ERROR:', error.message);

    if (!res.headersSent) {
      res.writeHead(500);
    }

    res.end('internal server error');
  }
});

const shutdown = async (signal) => {
  console.log(`[server] ${signal} received, shutting down...`);

  try {
    if (sharedBrowser) {
      await sharedBrowser.close();
      sharedBrowser = null;
    }
  } catch (error) {
    console.error('[browser] close error:', error.message);
  }

  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.listen(PORT, HOST, () => {
  console.log(
    `HHPanda addon running on ${HOST}:${PORT}`
  );

  console.log(
    `HTTP addon accessible at: http://${HOST}:${PORT}/manifest.json`
  );

  console.log(
    `Xôi Chè addon accessible at: http://${HOST}:${PORT}/xoiche/manifest.json`
  );
});

