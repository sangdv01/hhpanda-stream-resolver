const axios = require('axios');
const https = require('https');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const sharp = require('sharp');

const XOICHE = 'https://xoiche.tv';

// HTTP Client với keep-alive để tái sử dụng kết nối TLS, giảm 50% độ trễ mạng
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  keepAliveMsecs: 30000
});

const httpClient = axios.create({
  httpsAgent,
  timeout: 12000
});

/*
 * CACHE & LIMITS
 */
const DEFAULT_MATCHES_CACHE_TTL = 3 * 60 * 1000; // 3 phút khi không có trận live
const LIVE_MATCHES_CACHE_TTL = 60 * 1000; // 1 phút khi có trận đang live
const SOURCES_CACHE_TTL = 60 * 1000; // Cache link stream HLS 60 giây (bấm lại là tức thì 0ms)
const POSTER_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 giờ cho trận chưa đá
const LIVE_POSTER_CACHE_TTL = 60 * 1000; // 60 giây cho trận đang live
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
    const ttl = item.ttl || this.ttl;
    if (Date.now() - item.time > ttl) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value, customTtl) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      time: Date.now(),
      value,
      ttl: customTtl || this.ttl
    });
  }
}

const posterCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, POSTER_CACHE_TTL);
const logoCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, LOGO_CACHE_TTL);
const sourcesCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, SOURCES_CACHE_TTL); // Cache link stream
const inFlightPosters = new Map();
const inFlightSources = new Map(); // Chống gọi lặp lại khi Stremio probe stream
let rawMatchesPromise = null; // Gộp request meta và stream nếu đến cùng lúc

// Bảng ánh xạ vĩnh viễn slug -> fixtureId để KHÔNG BAO GIỜ phải cào HTML
const globalSlugToId = new Map();

const INITIAL_FALLBACK_MATCHES = [
  {
    id: 'xoiche:bournemouth-v-liverpool-1557407',
    type: 'movie',
    name: 'Bournemouth vs Liverpool',
    homeName: 'Bournemouth',
    awayName: 'Liverpool',
    description: 'Bournemouth vs Liverpool\nGiải đấu: Premier League',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z'
  },
  {
    id: 'xoiche:leeds-v-crystal-palace-1557412',
    type: 'movie',
    name: 'Leeds vs Crystal Palace',
    homeName: 'Leeds',
    awayName: 'Crystal Palace',
    description: 'Leeds vs Crystal Palace\nGiải đấu: Premier League',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z'
  },
  {
    id: 'xoiche:manchester-city-v-sunderland-1557413',
    type: 'movie',
    name: 'Manchester City vs Sunderland',
    homeName: 'Manchester City',
    awayName: 'Sunderland',
    description: 'Manchester City vs Sunderland\nGiải đấu: Premier League',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z'
  },
  {
    id: 'xoiche:fulham-v-manchester-united-1557411',
    type: 'movie',
    name: 'Fulham vs Manchester United',
    homeName: 'Fulham',
    awayName: 'Manchester United',
    description: 'Fulham vs Manchester United\nGiải đấu: Premier League',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T15:30:00.000Z'
  }
];

let matchesCache = {
  time: 0,
  matches: INITIAL_FALLBACK_MATCHES,
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
  version: '1.5.1',
  name: 'Xôi Chè Live',
  description: 'Xem trực tiếp Ngoại Hạng Anh & Chelsea từ Xôi Chè (Tỷ số trực tiếp)',
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
 * XỬ LÝ TRẠNG THÁI VÀ TỶ SỐ TRỰC TIẾP
 */
function parseScoreInfo(match) {
  const status = (match.status || '').toUpperCase();
  const elapsed = match.elapsed ? `${match.elapsed}'` : '';
  const hasScore = typeof match.homeScore === 'number' && typeof match.awayScore === 'number';
  const score = hasScore ? `${match.homeScore} - ${match.awayScore}` : '';

  if (status === 'HT') {
    return {
      isLive: true,
      isFinished: false,
      badge: hasScore ? `[HT ${score}]` : '[HT]',
      statusText: 'HT',
      scoreDisplay: score || '0 - 0',
      detailStatus: `Nghỉ giữa hiệp (HT)`
    };
  }

  if (status === '1H') {
    const timeBadge = elapsed ? `H1 ${elapsed}` : 'H1';
    return {
      isLive: true,
      isFinished: false,
      badge: hasScore ? `🔴 [${timeBadge} ${score}]` : `🔴 [${timeBadge}]`,
      statusText: elapsed || 'H1',
      scoreDisplay: score || '0 - 0',
      detailStatus: `Đang đá Hiệp 1 (${elapsed || 'H1'})`
    };
  }

  if (status === '2H') {
    const timeBadge = elapsed ? `H2 ${elapsed}` : 'H2';
    return {
      isLive: true,
      isFinished: false,
      badge: hasScore ? `🔴 [${timeBadge} ${score}]` : `🔴 [${timeBadge}]`,
      statusText: elapsed || 'H2',
      scoreDisplay: score || '0 - 0',
      detailStatus: `Đang đá Hiệp 2 (${elapsed || 'H2'})`
    };
  }

  if (status === 'FT' || status === 'AET' || status === 'FINISHED') {
    return {
      isLive: false,
      isFinished: true,
      badge: hasScore ? `[FT ${score}]` : '[FT]',
      statusText: 'FT',
      scoreDisplay: score || 'FT',
      detailStatus: `Đã kết thúc (FT)`
    };
  }

  if (status === 'LIVE' || (match.elapsed > 0 && hasScore)) {
    const timeBadge = elapsed || 'LIVE';
    return {
      isLive: true,
      isFinished: false,
      badge: `🔴 [${timeBadge} ${score}]`,
      statusText: elapsed || 'LIVE',
      scoreDisplay: score || '0 - 0',
      detailStatus: `Đang diễn ra (${elapsed})`
    };
  }

  return {
    isLive: false,
    isFinished: false,
    badge: '',
    statusText: '',
    scoreDisplay: '',
    detailStatus: 'Chưa diễn ra'
  };
}

/*
 * GET MATCHES TỪ API XOICHE (CÓ GỘP REQUEST IN-FLIGHT)
 */
async function getRawMatches(baseUrl) {
  const hasLiveMatch = matchesCache.matches.some(m => m.isLive);
  const cacheTtl = hasLiveMatch ? LIVE_MATCHES_CACHE_TTL : DEFAULT_MATCHES_CACHE_TTL;

  if (matchesCache.matches.length > 0 && Date.now() - matchesCache.time < cacheTtl) {
    return matchesCache;
  }

  // Nếu đang có 1 request lấy matches thì các request khác (meta/stream) dùng chung
  if (rawMatchesPromise) {
    return rawMatchesPromise;
  }

  rawMatchesPromise = (async () => {
    try {
      const response = await httpClient.get(`${XOICHE}/api/matches?filter=all`, {
        headers: HEADERS,
        timeout: 18000
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

        // Lưu cả vào bảng slugMap hiện tại và bảng global vĩnh viễn
        slugMap.set(match.slug, match.id);
        globalSlugToId.set(match.slug, match.id);

        const homeName = match.homeTeam?.name || '';
        const awayName = match.awayTeam?.name || '';
        if (!homeName || !awayName) continue;

        const kickoff = new Date(match.kickoffAt);
        const kickoffTime = timeFormatter.format(kickoff);
        const kickoffDate = dateFormatter.format(kickoff);

        const scoreInfo = parseScoreInfo(match);

        const displayName = scoreInfo.badge
          ? `${scoreInfo.badge} ${homeName} vs ${awayName}`
          : `${homeName} vs ${awayName}`;

        let description = `${homeName} vs ${awayName}\n`;
        if (scoreInfo.isLive || scoreInfo.isFinished) {
          description += `Tỷ số: ${match.homeScore ?? 0} - ${match.awayScore ?? 0}\n`;
          description += `Trạng thái: ${scoreInfo.detailStatus}\n`;
        }
        description += `Giải đấu: ${match.competition?.name || 'Bóng đá'}\n`;
        description += `Giờ đá: ${kickoffTime} - ${kickoffDate}`;

        unique.push({
          id: `xoiche:${match.slug}`,
          type: 'movie',
          name: displayName,
          homeName,
          awayName,
          description,
          releaseInfo: match.kickoffAt,
          website: `${XOICHE}/tran-dau/${encodeURIComponent(match.slug)}`,
          homeLogo: match.homeTeam?.logoUrl || '',
          awayLogo: match.awayTeam?.logoUrl || '',
          kickoffAt: match.kickoffAt,
          competition: match.competition?.name || '',
          competitionSlug: match.competition?.slug || '',
          competitionLogo: match.competition?.logoUrl || '',
          poster: `${posterBase}/poster/${encodeURIComponent(match.slug)}.png`,
          isLive: scoreInfo.isLive,
          isFinished: scoreInfo.isFinished,
          statusText: scoreInfo.statusText,
          scoreDisplay: scoreInfo.scoreDisplay
        });
      }

      matchesCache = {
        time: Date.now(),
        matches: unique,
        slugToFixtureId: slugMap
      };

      return matchesCache;
    } catch (err) {
      console.error('[xoiche api error]:', err.message);
      // Khi Xôi Chè 502 / timeout, đặt lại time để giữ cache cũ và không spam
      matchesCache.time = Date.now();
      return matchesCache;
    } finally {
      rawMatchesPromise = null;
    }
  })();

  return rawMatchesPromise;
}

/*
 * FILTER: PREMIER LEAGUE (EPL) HOẶC CÓ CHELSEA THAM GIA
 */
function filterMatches(matches) {
  return (matches || []).filter(match => {
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
    const list = filtered.length > 0 ? filtered : filterMatches(INITIAL_FALLBACK_MATCHES);

    // Sắp xếp: Live lên đầu -> Trận sắp đá -> Trận đã xong
    list.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;

      if (!a.isFinished && b.isFinished) return -1;
      if (a.isFinished && !b.isFinished) return 1;

      return new Date(a.kickoffAt) - new Date(b.kickoffAt);
    });

    return { metas: list };
  } catch (err) {
    console.error('[xoiche catalog] error:', err.message);
    const fallback = filterMatches(matchesCache.matches || INITIAL_FALLBACK_MATCHES);
    return { metas: fallback.length > 0 ? fallback : INITIAL_FALLBACK_MATCHES };
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
    const response = await httpClient.get(url, {
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

      let centerScoreSvg = '';
      if (match.isLive) {
        centerScoreSvg = `
    <text x="300" y="340" text-anchor="middle" fill="#ef4444" font-family="Arial, sans-serif" font-size="22" font-weight="bold">🔴 LIVE ${escapeXml(match.statusText)}</text>
    <text x="300" y="395" text-anchor="middle" fill="#facc15" font-family="Arial, sans-serif" font-size="44" font-weight="bold">${escapeXml(match.scoreDisplay)}</text>
        `;
      } else if (match.isFinished) {
        centerScoreSvg = `
    <text x="300" y="340" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="18" font-weight="bold">FULL TIME</text>
    <text x="300" y="395" text-anchor="middle" fill="#facc15" font-family="Arial, sans-serif" font-size="44" font-weight="bold">${escapeXml(match.scoreDisplay)}</text>
        `;
      } else {
        centerScoreSvg = `
    <text x="300" y="365" text-anchor="middle" fill="#facc15" font-family="Arial, sans-serif" font-size="42" font-weight="bold">VS</text>
        `;
      }

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
  
  ${centerScoreSvg}

  <text x="300" y="610" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="48" font-weight="bold">${kickoffTime}</text>
  <text x="300" y="655" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="25">${kickoffDate}</text>
  <rect x="80" y="730" width="440" height="2" fill="#475569"/>
  <text x="300" y="785" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="20">Xem trực tiếp bóng đá</text>
</svg>`;

      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      const posterTtl = match.isLive ? LIVE_POSTER_CACHE_TTL : POSTER_CACHE_TTL;
      posterCache.set(slug, png, posterTtl);

      return png;
    } finally {
      inFlightPosters.delete(slug);
    }
  })();

  inFlightPosters.set(slug, task);
  return task;
}

/*
 * GET SOURCES (SIÊU TỐC - CÓ CACHE & DEDUPLICATION)
 */
async function getSources(slug) {
  // 1. Kiểm tra cache sources trước: nếu đã lấy trong vòng 60s thì trả về 0ms!
  const cached = sourcesCache.get(slug);
  if (cached) {
    return cached;
  }

  // 2. Chống lặp request khi Stremio gọi 2 lần cùng lúc
  if (inFlightSources.has(slug)) {
    return inFlightSources.get(slug);
  }

  const task = (async () => {
    try {
      // 3. Lấy fixtureId từ bộ nhớ vĩnh viễn (0ms)
      let fixtureId = globalSlugToId.get(slug) || matchesCache.slugToFixtureId.get(slug);

      if (!fixtureId) {
        await getRawMatches();
        fixtureId = globalSlugToId.get(slug) || matchesCache.slugToFixtureId.get(slug);
      }

      // 4. Chỉ cào HTML dự phòng nếu thực sự không có ID
      if (!fixtureId) {
        try {
          const pageRes = await httpClient.get(`${XOICHE}/tran-dau/${encodeURIComponent(slug)}`, {
            headers: HEADERS,
            timeout: 6000
          });
          const m = pageRes.data.match(/\\"match\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"/i);
          if (m) {
            fixtureId = m[1];
            globalSlugToId.set(slug, fixtureId);
          }
        } catch (e) {
          console.error('[xoiche html scrape fallback] failed:', e.message);
        }
      }

      if (!fixtureId) {
        throw new Error(`Không tìm thấy fixtureId cho trận: ${slug}`);
      }

      // 5. Gọi API lấy danh sách luồng với Referer và keep-alive
      const response = await httpClient.get(`${XOICHE}/api/matches/${encodeURIComponent(fixtureId)}/sources`, {
        headers: {
          ...HEADERS,
          'Accept': 'application/json',
          'Referer': `${XOICHE}/tran-dau/${encodeURIComponent(slug)}`
        },
        timeout: 7000
      });

      const sourcesData = response.data || {};
      sourcesCache.set(slug, sourcesData);
      return sourcesData;
    } finally {
      inFlightSources.delete(slug);
    }
  })();

  inFlightSources.set(slug, task);
  return task;
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
        url: sources.mainChannel.hlsUrl,
        behaviorHints: {
          notWebReady: false
        }
      });
    }

    for (const room of sources?.partnerRooms || []) {
      if (!room.hlsUrl) continue;
      streams.push({
        name: `Xôi Chè - ${room.name || 'BLV'}`,
        title: `BLV ${room.name || ''}`.trim(),
        url: room.hlsUrl,
        behaviorHints: {
          notWebReady: false
        }
      });
    }

    // Loại bỏ link trùng
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

  // 1. Redirect /xoiche hoặc /xoiche/
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

      const match = matchesCache.matches.find(m => m.id === `xoiche:${slug}`);
      const maxAge = match?.isLive ? 60 : 86400;

      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': `public, max-age=${maxAge}`,
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
