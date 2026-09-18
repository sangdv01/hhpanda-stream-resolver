const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const resolver = require('./resolve');

const HHPANDA = 'https://hhpanda.st';

const builder = new addonBuilder({
  id: 'community.hhpanda',
  version: '1.2.1',
  name: 'HHPanda',
  logo: 'https://hhpanda.st/wp-content/uploads/2024/10/gia-thien-292-300x450.webp',
  description: 'HHPanda • Hoạt hình Trung Quốc 3D • Thuyết Minh',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  catalogs: [
    {
      type: 'series',
      id: 'hhpanda',
      name: 'HHPanda'
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

  if (type !== 'series' || id !== 'hhpanda') {
    return { metas: [] };
  }

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
    console.error('[catalog] FAILED:', error.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[meta] ${type} ${id}`);

  if (type !== 'series') {
    return { meta: null };
  }

  try {
    const meta = await fetchMeta(id);

    return { meta };
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

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] ${type} ${id}`);

  if (type !== 'series') {
    return { streams: [] };
  }

  let resolution = null;
  let gateway = null;

  try {
    resolution = await resolver.resolveHHPandaEpisode(
      id,
      'pro',
      null
    );

    console.log(
      `[stream] ${resolution.mappings.length} mappings resolved`
    );

    gateway = await resolver.startStreamGateway(
      resolution,
      {
        host: '127.0.0.1',
        port: 0
      }
    );

    console.log(
      `[stream] gateway: ${gateway.streamUrl}`
    );

    return {
      streams: [
        {
          name: 'HHPanda • 1080P V2 • Lồng tiếng',
          title: 'HHPanda • Thuyết Minh',
          url: gateway.streamUrl,
          behaviorHints: {
            notWebReady: true
          }
        }
      ]
    };
  } catch (error) {
    console.error('[stream] FAILED:', error.message);

    if (gateway?.server) {
      gateway.server.close();
    }

    return {
      streams: []
    };
  }
});

const PORT = 7000;

serveHTTP(builder.getInterface(), {
  port: PORT
});

console.log('HHPanda addon running on port', PORT);
console.log(
  `HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`
);
