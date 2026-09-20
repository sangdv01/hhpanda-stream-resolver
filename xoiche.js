const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const sharp = require('sharp');

const XOICHE = 'https://xoiche.tv';

/*
 * CACHE & LIMITS
 */
const MATCHES_CACHE_TTL = 3 * 60 * 1000; // 3 phút
const POSTER_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 giờ
const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 giờ
const MAX_CACHE_ENTRIES = 100;

class SimpleLRUCache {
  constructor(max = 100, ttl = 3600000) {
    this.max = max;
    this.ttl = ttl;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.time > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { time: Date.now(), value });
  }
}

const posterCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, POSTER_CACHE_TTL);
const logoCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, LOGO_CACHE_TTL);
const inFlightPosters = new Map();

let matchesCache = {
  time: 0,
  matches: [],
  slugToFixtureId: new Map()
};

let currentPublicBase = '';

function getPublicBaseUrl(req) {
  if (process.env.AZURE_PUBLIC_URL) {
    return `${process.env.AZURE_PUBLIC_URL}/xoiche`;
  }
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/xoiche`;
  }
  const host = req?.headers?.host || `127.0.0.1:${process.env.PORT || 7000}`;
  const proto = req?.headers?.['x-forwarded-proto'] || 'http';
  return `${proto}://${host}/xoiche`;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
};

const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

const builder = new addonBuilder({
  id: 'community.xoiche',
  version: '1.4.0',
  name: 'Xôi Chè Live',
  description: 'Xem trực tiếp Ngoại Hạng Anh & Chelsea từ Xôi Chè',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [
    {
      type: 'movie',
      id: 'xoiche-live',
      name: 'Xôi Chè Live (EPL & Chelsea)'
    }
  ],
  idPrefixes: ['xoiche:']
});

/*
 * GET MATCHES TỪ API XOICHE
 */
async function getRawMatches(baseUrl) {
  if (matchesCache.matches.length > 0 && Date.now() - matchesCache.time < MATCHES_CACHE_TTL) {
    return matchesCache;
  }

  const response = await axios.get(`${XOICHE}/api/matches?filter=all`, {
    headers: HEADERS,
    timeout: 10000
  });

  const data = response.data || {};
  const rawMatches = [
    ...(Array.isArray(data.live) ? data.live : []),
    ...(Array.isArray(data.spotlight) ? data.spotlight : []),
    ...(Array.isArray(data.scoreboard) ? data.scoreboard : []),
    ...(Array.isArray(data.pinned) ? data.pinned : [])
  ];

  const unique = [];
  const seen = new Set();
  const slugMap = new Map();
  const posterBase = baseUrl || currentPublicBase || getPublicBaseUrl();

  for (const match of rawMatches) {
    if (!match || match.sport !== 'football' || !match.id || !match.slug) continue;
    if (seen.has(match.id)) continue;
    seen.add(match.id);

    slugMap.set(match.slug, match.id);

    const homeName = match.homeTeam?.name || '';
    const awayName = match.awayTeam?.name || '';
    if (!homeName || !awayName) continue;

    const kickoff = new Date(match.kickoffAt);
    const kickoffTime = timeFormatter.format(kickoff);
    const kickoffDate = dateFormatter.format(kickoff);

    unique.push({
      id: `xoiche:${match.slug}`,
      type: 'movie',
      name: `${homeName} vs ${awayName}`,
      homeName,
      awayName,
      description: `${homeName} vs ${awayName}\nGiải đấu: ${match.competition?.name || 'Bóng đá'}\nGiờ đá: ${kickoffTime} - ${kickoffDate}`,
      releaseInfo: match.kickoffAt,
      website: `${XOICHE}/tran-dau/${encodeURIComponent(match.slug)}`,
      homeLogo: match.homeTeam?.logoUrl || '',
      awayLogo: match.awayTeam?.logoUrl || '',
      kickoffAt: match.kickoffAt,
      competition: match.competition?.name || '',
      competitionSlug: match.competition?.slug || '',
      competitionLogo: match.competition?.logoUrl || '',
      poster: `${posterBase}/poster/${encodeURIComponent(match.slug)}.png`
    });
  }

  matchesCache = {
    time: Date.now(),
    matches: unique,
    slugToFixtureId: slugMap
  };

  return matchesCache;
}

/*
 * FILTER: PREMIER LEAGUE (EPL) HOẶC CÓ CHELSEA THAM GIA
 */
function filterMatches(matches) {
  return matches.filter(match => {
    const compSlug = (match.competitionSlug || '').toLowerCase();
    const compName = (match.competition || '').toLowerCase();
    const isEpl = compSlug.includes('premier-league') || compName.includes('premier league');

    const home = (match.homeName || '').toLowerCase();
    const away = (match.awayName || '').toLowerCase();
    const isChelsea = home.includes('chelsea') || away.includes('chelsea');

    return isEpl || isChelsea;
  });
}

/*
 * CATALOG HANDLER
 */
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== 'movie' || id !== 'xoiche-live') return { metas: [] };

  try {
    const { matches } = await getRawMatches();
    const filtered = filterMatches(matches);
    filtered.sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
    return { metas: filtered };
  } catch (err) {
    console.error('[xoiche catalog] error:', err.message);
    return { metas: filterMatches(matchesCache.matches || []) };
  }
});

/*
 * META HANDLER
 */
builder.defineMetaHandler(async ({ id }) => {
  const slug = id.replace('xoiche:', '');
  try {
    const { matches } = await getRawMatches();
    const found = matches.find(m => m.id === id);
    return {
      meta: found || { id, type: 'movie', name: slug }
    };
  } catch (err) {
    return { meta: { id, type: 'movie', name: slug } };
  }
});

/*
 * LOGO LOADER
 */
async function getLogoDataUri(url) {
  if (!url) return '';
  const cached = logoCache.get(url);
  if (cached) return cached;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: HEADERS,
      timeout: 5000
    });
    const contentType = response.headers['content-type'] || 'image/png';
    const dataUri = `data:${contentType};base64,${Buffer.from(response.data).toString('base64')}`;
    logoCache.set(url, dataUri);
    return dataUri;
  } catch (e) {
    return '';
  }
}

/*
 * POSTER PNG GENERATOR
 */
async function createPosterPNG(slug) {
  const cached = posterCache.get(slug);
  if (cached) return cached;

  if (inFlightPosters.has(slug)) {
    return inFlightPosters.get(slug);
  }

  const task = (async () => {
    try {
      const { matches } = await getRawMatches();
      const match = matches.find(m => m.id === `xoiche:${slug}`);
      if (!match) return null;

      const homeName = match.homeName || '';
      const awayName = match.awayName || '';
      const kickoff = new Date(match.kickoffAt);
      const kickoffTime = timeFormatter.format(kickoff);
      const kickoffDate = dateFormatter.format(kickoff);

      const escapeXml = str => String(str || '').replace(/[<>&"']/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
      }[c]));

      const [homeLogo, awayLogo] = await Promise.all([
        getLogoDataUri(match.homeLogo),
        getLogoDataUri(match.awayLogo)
      ]);

      const compDisplay = (match.competition || 'BÓNG ĐÁ').toUpperCase();
      const compFontSize = compDisplay.length > 32 ? 16 : (compDisplay.length > 22 ? 18 : 20);

      const getTeamFontSize = name => {
        if (name.length > 20) return 17;
        if (name.length > 15) return 20;
        return 24;
      };

      const homeFontSize = getTeamFontSize(homeName);
      const awayFontSize = getTeamFontSize(awayName);

      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101828"/>
      <stop offset="100%" stop-color="#172554"/>
    </linearGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <text x="300" y="75" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="30" font-weight="bold">XÔI CHÈ LIVE</text>
  <text x="300" y="120" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="${compFontSize}">${escapeXml(compDisplay)}</text>
  
  <circle cx="190" cy="315" r="125" fill="white" opacity="0.96"/>
  <circle cx="410" cy="315" r="125" fill="white" opacity="0.96"/>
  
  ${homeLogo ? `<image x="90" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${homeLogo}"/>` : ''}
  ${awayLogo ? `<image x="310" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${awayLogo}"/>` : ''}

  <text x="190" y="490" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="${homeFontSize}" font-weight="bold">${escapeXml(homeName)}</text>
  <text x="410" y="490" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="${awayFontSize}" font-weight="bold">${escapeXml(awayName)}</text>
  <text x="300" y="365" text-anchor="middle" fill="#facc15" font-family="Arial, sans-serif" font-size="42" font-weight="bold">VS</text>
  <text x="300" y="610" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="48" font-weight="bold">${kickoffTime}</text>
  <text x="300" y="655" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="25">${kickoffDate}</text>
  <rect x="80" y="730" width="440" height="2" fill="#475569"/>
  <text x="300" y="785" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="20">Xem trực tiếp bóng đá</text>
</svg>`;

      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      posterCache.set(slug, png);
      return png;
    } finally {
      inFlightPosters.delete(slug);
    }
  })();

  inFlightPosters.set(slug, task);
  return task;
}

/*
 * GET SOURCES
 */
async function getSources(slug) {
  let fixtureId = matchesCache.slugToFixtureId.get(slug);

  if (!fixtureId) {
    const { slugToFixtureId } = await getRawMatches();
    fixtureId = slugToFixtureId.get(slug);
  }

  if (!fixtureId) {
    try {
      const pageRes = await axios.get(`${XOICHE}/tran-dau/${encodeURIComponent(slug)}`, {
        headers: HEADERS,
        timeout: 10000
      });
      const m = pageRes.data.match(/\\"match\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"/i);
      if (m) fixtureId = m[1];
    } catch (e) {
      console.error('[xoiche html scrape fallback] failed:', e.message);
    }
  }

  if (!fixtureId) {
    throw new Error(`Không tìm thấy fixtureId cho trận: ${slug}`);
  }

  const response = await axios.get(`${XOICHE}/api/matches/${encodeURIComponent(fixtureId)}/sources`, {
    headers: { ...HEADERS, 'Accept': 'application/json' },
    timeout: 10000
  });
  return response.data;
}

/*
 * STREAM HANDLER
 */
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'movie' || !id.startsWith('xoiche:')) return { streams: [] };
  const slug = id.replace('xoiche:', '');

  try {
    const sources = await getSources(slug);
    const streams = [];

    if (sources?.mainChannel?.hlsUrl) {
      streams.push({
        name: 'Xôi Chè - Main',
        title: 'Main Channel',
        url: sources.mainChannel.hlsUrl
      });
    }

    for (const room of sources?.partnerRooms || []) {
      if (!room.hlsUrl) continue;
      streams.push({
        name: `Xôi Chè - ${room.name || 'BLV'}`,
        title: `BLV ${room.name || ''}`.trim(),
        url: room.hlsUrl
      });
    }

    const unique = [];
    const seen = new Set();
    for (const stream of streams) {
      if (!seen.has(stream.url)) {
        seen.add(stream.url);
        unique.push(stream);
      }
    }
    return { streams: unique };
  } catch (err) {
    console.error('[xoiche stream] error:', err.message);
    return { streams: [] };
  }
});

const addonRouter = getRouter(builder.getInterface());

/*
 * EXPORTED REQUEST HANDLER FOR HTTP SERVER
 */
async function handleRequest(req, res, requestUrl) {
  currentPublicBase = getPublicBaseUrl(req);

  // 1. Trợ giúp redirect nếu truy cập /xoiche hoặc /xoiche/
  if (requestUrl.pathname === '/xoiche' || requestUrl.pathname === '/xoiche/') {
    res.writeHead(302, { Location: '/xoiche/manifest.json' });
    return res.end();
  }

  // 2. Poster handler: /xoiche/poster/:slug.png
  const posterMatch = requestUrl.pathname.match(/^\/xoiche\/poster\/([^/]+)\.png$/);
  if (posterMatch) {
    const slug = decodeURIComponent(posterMatch[1]);
    try {
      const png = await createPosterPNG(slug);
      if (!png) {
        res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return res.end('Poster not found');
      }

      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*'
      });
      return res.end(png);
    } catch (err) {
      console.error('[xoiche poster] error:', err.message);
      res.writeHead(500, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      return res.end('Poster error');
    }
  }

  // 3. Stremio Addon Router (/manifest.json, /catalog/..., /meta/..., /stream/...)
  const originalUrl = req.url;
  // Cắt tiền tố /xoiche để router của stremio-addon-sdk xử lý
  req.url = req.url.slice('/xoiche'.length) || '/';

  try {
    return addonRouter(req, res, () => {
      req.url = originalUrl;
      if (!res.headersSent) {
        res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        res.end('not found in xoiche addon');
      }
    });
  } catch (err) {
    req.url = originalUrl;
    console.error('[xoiche router] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('xoiche internal error');
    }
  }
}

module.exports = {
  handleRequest,
  builder
};
