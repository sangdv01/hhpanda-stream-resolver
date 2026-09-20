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
const SOURCES_CACHE_TTL = 90 * 1000; // Cache link stream HLS 90 giây (bấm lại là tức thì 0ms)
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

const EPL_BADGES = {
  'arsenal': 'https://resources.premierleague.com/premierleague/badges/50/t3.png',
  'aston-villa': 'https://resources.premierleague.com/premierleague/badges/50/t7.png',
  'bournemouth': 'https://resources.premierleague.com/premierleague/badges/50/t91.png',
  'brentford': 'https://resources.premierleague.com/premierleague/badges/50/t94.png',
  'brighton': 'https://resources.premierleague.com/premierleague/badges/50/t36.png',
  'chelsea': 'https://resources.premierleague.com/premierleague/badges/50/t8.png',
  'crystal-palace': 'https://resources.premierleague.com/premierleague/badges/50/t31.png',
  'everton': 'https://resources.premierleague.com/premierleague/badges/50/t11.png',
  'fulham': 'https://resources.premierleague.com/premierleague/badges/50/t54.png',
  'ipswich': 'https://resources.premierleague.com/premierleague/badges/50/t40.png',
  'leicester': 'https://resources.premierleague.com/premierleague/badges/50/t13.png',
  'liverpool': 'https://resources.premierleague.com/premierleague/badges/50/t14.png',
  'manchester-city': 'https://resources.premierleague.com/premierleague/badges/50/t43.png',
  'manchester-united': 'https://resources.premierleague.com/premierleague/badges/50/t1.png',
  'newcastle': 'https://resources.premierleague.com/premierleague/badges/50/t4.png',
  'nottingham-forest': 'https://resources.premierleague.com/premierleague/badges/50/t17.png',
  'southampton': 'https://resources.premierleague.com/premierleague/badges/50/t20.png',
  'tottenham': 'https://resources.premierleague.com/premierleague/badges/50/t6.png',
  'west-ham': 'https://resources.premierleague.com/premierleague/badges/50/t21.png',
  'wolves': 'https://resources.premierleague.com/premierleague/badges/50/t39.png',
  'wolverhampton': 'https://resources.premierleague.com/premierleague/badges/50/t39.png',
  'leeds': 'https://resources.premierleague.com/premierleague/badges/50/t2.png',
  'sunderland': 'https://resources.premierleague.com/premierleague/badges/50/t56.png'
};

function getTeamBadge(teamName) {
  const norm = (teamName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, url] of Object.entries(EPL_BADGES)) {
    const cleanKey = key.replace(/[^a-z0-9]/g, '');
    if (norm.includes(cleanKey) || cleanKey.includes(norm)) {
      return url;
    }
  }
  return '';
}

const DEFAULT_REMOTE_HOST = 'hhpanda-resolver.purplecliff-189df27e.southeastasia.azurecontainerapps.io';

const INITIAL_FALLBACK_MATCHES = [
  {
    id: 'xoiche:bournemouth-v-liverpool-1557407',
    type: 'movie',
    name: '[FT 0-1] Bournemouth vs Liverpool',
    homeName: 'Bournemouth',
    awayName: 'Liverpool',
    description: 'Bournemouth vs Liverpool\nTỷ số: 0 - 1\nTrạng thái: Đã kết thúc (FT)\nGiải đấu: Premier League\nGiờ đá: 20:00 - 20/09/2026',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z',
    isLive: false,
    isFinished: true,
    statusText: 'FT',
    scoreDisplay: '0 - 1',
    homeLogo: 'https://resources.premierleague.com/premierleague/badges/50/t91.png',
    awayLogo: 'https://resources.premierleague.com/premierleague/badges/50/t14.png',
    poster: `https://${DEFAULT_REMOTE_HOST}/xoiche/poster/bournemouth-v-liverpool-1557407.png`
  },
  {
    id: 'xoiche:leeds-v-crystal-palace-1557412',
    type: 'movie',
    name: '[FT 0-0] Leeds vs Crystal Palace',
    homeName: 'Leeds',
    awayName: 'Crystal Palace',
    description: 'Leeds vs Crystal Palace\nTỷ số: 0 - 0\nTrạng thái: Đã kết thúc (FT)\nGiải đấu: Premier League\nGiờ đá: 20:00 - 20/09/2026',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z',
    isLive: false,
    isFinished: true,
    statusText: 'FT',
    scoreDisplay: '0 - 0',
    homeLogo: 'https://resources.premierleague.com/premierleague/badges/50/t2.png',
    awayLogo: 'https://resources.premierleague.com/premierleague/badges/50/t31.png',
    poster: `https://${DEFAULT_REMOTE_HOST}/xoiche/poster/leeds-v-crystal-palace-1557412.png`
  },
  {
    id: 'xoiche:manchester-city-v-sunderland-1557413',
    type: 'movie',
    name: '[FT 5-3] Manchester City vs Sunderland',
    homeName: 'Manchester City',
    awayName: 'Sunderland',
    description: 'Manchester City vs Sunderland\nTỷ số: 5 - 3\nTrạng thái: Đã kết thúc (FT)\nGiải đấu: Premier League\nGiờ đá: 20:00 - 20/09/2026',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T13:00:00.000Z',
    isLive: false,
    isFinished: true,
    statusText: 'FT',
    scoreDisplay: '5 - 3',
    homeLogo: 'https://resources.premierleague.com/premierleague/badges/50/t43.png',
    awayLogo: 'https://resources.premierleague.com/premierleague/badges/50/t56.png',
    poster: `https://${DEFAULT_REMOTE_HOST}/xoiche/poster/manchester-city-v-sunderland-1557413.png`
  },
  {
    id: 'xoiche:fulham-v-manchester-united-1557411',
    type: 'movie',
    name: 'Fulham vs Manchester United',
    homeName: 'Fulham',
    awayName: 'Manchester United',
    description: 'Fulham vs Manchester United\nGiải đấu: Premier League\nGiờ đá: 22:30 - 20/09/2026',
    competition: 'Premier League',
    competitionSlug: 'premier-league-39',
    kickoffAt: '2026-09-20T15:30:00.000Z',
    isLive: false,
    isFinished: false,
    statusText: '',
    scoreDisplay: '0 - 0',
    homeLogo: 'https://resources.premierleague.com/premierleague/badges/50/t54.png',
    awayLogo: 'https://resources.premierleague.com/premierleague/badges/50/t1.png',
    poster: `https://${DEFAULT_REMOTE_HOST}/xoiche/poster/fulham-v-manchester-united-1557411.png`
  }
];

let matchesCache = {
  time: 0,
  matches: INITIAL_FALLBACK_MATCHES,
  slugToFixtureId: new Map()
};

let currentPublicBase = '';
let currentHost = '';

function getPublicBaseUrl(req) {
  if (process.env.AZURE_PUBLIC_URL) {
    return `${process.env.AZURE_PUBLIC_URL}/xoiche`;
  }
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/xoiche`;
  }
  const host = req?.headers?.host || currentHost || DEFAULT_REMOTE_HOST;
  if (req?.headers?.host && !req.headers.host.includes('127.0.0.1')) {
    currentHost = req.headers.host;
  }
  const proto = req?.headers?.['x-forwarded-proto'] || (host.includes('127.0.0.1') ? 'http' : 'https');
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
  version: '1.6.2',
  name: 'Xôi Chè Live',
  description: 'Xem trực tiếp Ngoại Hạng Anh & Chelsea (Tỷ số LiveScore & Đa nguồn Xoilac HD)',
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

function parseLiveScoreDate(esd) {
  const str = String(esd || '');
  if (str.length >= 14) {
    const y = parseInt(str.slice(0, 4), 10);
    const m = parseInt(str.slice(4, 6), 10) - 1;
    const d = parseInt(str.slice(6, 8), 10);
    const h = parseInt(str.slice(8, 10), 10);
    const min = parseInt(str.slice(10, 12), 10);
    const s = parseInt(str.slice(12, 14), 10);
    return new Date(Date.UTC(y, m, d, h, min, s)).toISOString();
  }
  return new Date().toISOString();
}

/*
 * GET MATCHES TỪ LIVESCORE (SIÊU TỐC ~150MS, CHUẨN TỶ SỐ TRỰC TIẾP & LOGO HD)
 */
async function getMatchesFromLiveScore(posterBase) {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://prod-public-api.livescore.com/v1/api/app/date/soccer/${today}/0?locale=en`;
    const res = await httpClient.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 4000
    });
    const stages = res.data?.Stages || [];
    const matches = [];

    for (const st of stages) {
      const isEpl = st.Scd === 'premier-league' && st.Ccd === 'england';
      for (const ev of st.Events || []) {
        const homeName = ev.T1?.[0]?.Nm || '';
        const awayName = ev.T2?.[0]?.Nm || '';
        const isChelsea = (homeName === 'Chelsea' || awayName === 'Chelsea');
        if (!isEpl && !isChelsea) continue;

        const homeScore = parseInt(ev.Tr1 ?? 0, 10);
        const awayScore = parseInt(ev.Tr2 ?? 0, 10);
        const eps = (ev.Eps || '').toUpperCase();
        const elapsed = ev.Min ? `${ev.Min}'` : '';

        let isLive = false;
        let isFinished = false;
        let badge = '';
        let statusText = '';
        let scoreDisplay = `${homeScore} - ${awayScore}`;
        let detailStatus = 'Chưa diễn ra';

        if (eps === 'FT' || eps === 'AET' || eps === 'AP') {
          isFinished = true;
          badge = `[FT ${homeScore}-${awayScore}]`;
          statusText = 'FT';
          detailStatus = 'Đã kết thúc (FT)';
        } else if (eps === 'HT') {
          isLive = true;
          badge = `[HT ${homeScore}-${awayScore}]`;
          statusText = 'HT';
          detailStatus = 'Nghỉ giữa hiệp (HT)';
        } else if (eps === '1H' || eps === '2H' || eps === 'LIVE' || (!isNaN(parseInt(eps, 10)) && parseInt(eps, 10) > 0)) {
          isLive = true;
          const currentMin = elapsed || (eps.includes('H') ? eps : `${eps}'`);
          badge = `🔴 [${currentMin} ${homeScore}-${awayScore}]`;
          statusText = currentMin;
          detailStatus = `Đang diễn ra (${currentMin})`;
        } else if (eps === 'NS') {
          detailStatus = 'Sắp diễn ra';
        }

        const kickoffAt = parseLiveScoreDate(ev.Esd);
        const kickoff = new Date(kickoffAt);
        const kickoffTime = timeFormatter.format(kickoff);
        const kickoffDate = dateFormatter.format(kickoff);

        const homeSlug = homeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const awaySlug = awayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const slug = `${homeSlug}-v-${awaySlug}-${ev.Eid}`;

        const displayName = badge ? `${badge} ${homeName} vs ${awayName}` : `${homeName} vs ${awayName}`;

        const compTitle = isEpl ? 'Premier League' : (st.Snm || 'Bóng đá');
        const compSlug = isEpl ? 'premier-league' : (st.Scd || 'football');

        const homeImg = ev.T1?.[0]?.Img ? `https://lsm-static-prod.livescore.com/medium/${ev.T1[0].Img}` : '';
        const awayImg = ev.T2?.[0]?.Img ? `https://lsm-static-prod.livescore.com/medium/${ev.T2[0].Img}` : '';
        const homeLogo = getTeamBadge(homeName) || homeImg;
        const awayLogo = getTeamBadge(awayName) || awayImg;

        let description = `${homeName} vs ${awayName}\n`;
        if (isLive || isFinished) {
          description += `Tỷ số: ${homeScore} - ${awayScore}\n`;
          description += `Trạng thái: ${detailStatus}\n`;
        }
        description += `Giải đấu: ${compTitle}\n`;
        description += `Giờ đá: ${kickoffTime} - ${kickoffDate}`;

        matches.push({
          id: `xoiche:${slug}`,
          type: 'movie',
          name: displayName,
          homeName,
          awayName,
          description,
          releaseInfo: kickoffAt,
          homeLogo,
          awayLogo,
          kickoffAt,
          competition: compTitle,
          competitionSlug: compSlug,
          poster: `${posterBase}/poster/${encodeURIComponent(slug)}.png`,
          isLive,
          isFinished,
          statusText,
          scoreDisplay
        });
      }
    }
    return matches;
  } catch (err) {
    console.error('[livescore api error]:', err.message);
    return [];
  }
}

/*
 * REFRESH MATCHES (CHẠY SONG SONG LIVESCORE & XOICHE, KHÔNG CHỜ TIMEOUT)
 */
async function refreshMatches(baseUrl) {
  if (rawMatchesPromise) {
    return rawMatchesPromise;
  }

  rawMatchesPromise = (async () => {
    try {
      const posterBase = baseUrl || currentPublicBase || getPublicBaseUrl();

      // 1. Tải LiveScore siêu tốc (chỉ ~150ms trên Azure)
      const liveScoreMatches = await getMatchesFromLiveScore(posterBase);

      // 2. Gọi Xôi Chè trong nền (không chặn catalog người dùng) để lấy fixtureId
      httpClient.get(`${XOICHE}/api/matches?filter=all`, {
        headers: HEADERS,
        timeout: 2500
      }).then(response => {
        const data = response.data || {};
        const xoicheMatches = [
          ...(Array.isArray(data.live) ? data.live : []),
          ...(Array.isArray(data.spotlight) ? data.spotlight : []),
          ...(Array.isArray(data.scoreboard) ? data.scoreboard : []),
          ...(Array.isArray(data.pinned) ? data.pinned : [])
        ];
        for (const m of xoicheMatches) {
          if (m?.slug && m?.id) {
            globalSlugToId.set(m.slug, m.id);
          }
        }
      }).catch(() => {});

      let unique = [];
      if (liveScoreMatches.length > 0) {
        unique = liveScoreMatches;
      } else if (matchesCache.matches.length > 0 && matchesCache.time > 0) {
        unique = matchesCache.matches;
      } else {
        unique = INITIAL_FALLBACK_MATCHES.map(m => ({
          ...m,
          poster: `${posterBase}/poster/${encodeURIComponent(m.id.replace('xoiche:', ''))}.png`,
          homeLogo: getTeamBadge(m.homeName),
          awayLogo: getTeamBadge(m.awayName)
        }));
      }

      matchesCache = {
        time: Date.now(),
        matches: unique,
        slugToFixtureId: globalSlugToId
      };

      // Tự động làm nóng (pre-warm) trước ảnh poster trong RAM
      for (const m of unique) {
        const s = m.id.replace('xoiche:', '');
        createPosterPNG(s).catch(() => {});
      }

      return matchesCache;
    } catch (err) {
      console.error('[refreshMatches error]:', err.message);
      matchesCache.time = Date.now();
      return matchesCache;
    } finally {
      rawMatchesPromise = null;
    }
  })();

  return rawMatchesPromise;
}

/*
 * GET RAW MATCHES (STALE-WHILE-REVALIDATE: PHẢN HỒI TỨC THÌ 0MS)
 */
async function getRawMatches(baseUrl) {
  const hasLiveMatch = matchesCache.matches.some(m => m.isLive);
  const cacheTtl = hasLiveMatch ? LIVE_MATCHES_CACHE_TTL : DEFAULT_MATCHES_CACHE_TTL;

  // 1. Nếu đã có cache và còn mới -> trả về ngay 0ms
  if (matchesCache.time > 0 && Date.now() - matchesCache.time < cacheTtl) {
    return matchesCache;
  }

  // 2. Nếu đã có cache nhưng hết hạn (stale) -> trả về ngay cache cũ 0ms, cập nhật ngầm
  if (matchesCache.time > 0 && matchesCache.matches.length > 0) {
    refreshMatches(baseUrl).catch(() => {});
    return matchesCache;
  }

  // 3. Khởi động lạnh (cold start) lần đầu tiên chưa có gì -> mới phải chờ LiveScore nạp
  return refreshMatches(baseUrl);
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

    // Kích hoạt nạp trước luồng stream trong nền (pre-warm) ngay khi người dùng bấm vào xem thông tin trận
    if (found && (found.isLive || !found.isFinished)) {
      getCombinedStreams(slug, found.homeName, found.awayName).catch(() => {});
    }

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
      let match = matches.find(m => m.id === `xoiche:${slug}`) ||
                  INITIAL_FALLBACK_MATCHES.find(m => m.id === `xoiche:${slug}`);

      if (!match) {
        const { home, away } = extractTeamsFromSlug(slug);
        match = {
          homeName: home || 'Đội nhà',
          awayName: away || 'Đội khách',
          kickoffAt: new Date().toISOString(),
          competition: 'Premier League',
          scoreDisplay: 'VS',
          statusText: '',
          isLive: false,
          isFinished: false
        };
      }

      const homeName = match.homeName || '';
      const awayName = match.awayName || '';
      const kickoff = new Date(match.kickoffAt);
      const kickoffTime = timeFormatter.format(kickoff);
      const kickoffDate = dateFormatter.format(kickoff);

      const escapeXml = str => String(str || '').replace(/[<>&"']/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
      }[c]));

      const [homeLogo, awayLogo] = await Promise.all([
        getLogoDataUri(match.homeLogo || getTeamBadge(homeName)),
        getLogoDataUri(match.awayLogo || getTeamBadge(awayName))
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
  
  ${homeLogo ? `<image x="90" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${homeLogo}"/>` : `<text x="190" y="335" text-anchor="middle" fill="#1e293b" font-family="Arial, sans-serif" font-size="64" font-weight="bold">${escapeXml((homeName[0] || '⚽').toUpperCase())}</text>`}
  ${awayLogo ? `<image x="310" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${awayLogo}"/>` : `<text x="410" y="335" text-anchor="middle" fill="#1e293b" font-family="Arial, sans-serif" font-size="64" font-weight="bold">${escapeXml((awayName[0] || '⚽').toUpperCase())}</text>`}

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
 * XOILAC SCRAPER & STREAM RESOLVER (DỰ PHÒNG & BỔ SUNG ĐA NGUỒN)
 */
const XOILAC_BASE = 'https://xoilacxbi.tv';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';

let xoilacMatchesCache = { time: 0, matches: [] };

async function getXoilacMatches() {
  if (Date.now() - xoilacMatchesCache.time < 180000 && xoilacMatchesCache.matches.length > 0) {
    return xoilacMatchesCache.matches;
  }
  try {
    const res = await httpClient.get(`${XOILAC_BASE}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 5000
    });
    const matches = [];
    const linkRegex = /<a\s+[^>]*href=["'](https?:\/\/[^"']*\/truc-tiep\/[^"']+|\/truc-tiep\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = linkRegex.exec(res.data)) !== null) {
      let href = m[1];
      if (href.endsWith('/truc-tiep/')) continue;
      // Chuẩn hoá URL, bỏ các link con /link/0
      href = href.replace(/\/link\/\d+.*$/, '');
      if (!href.endsWith('/')) href += '/';
      if (!href.startsWith('http')) href = `${XOILAC_BASE}${href}`;
      if (seen.has(href)) continue;
      seen.add(href);
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      matches.push({ url: href, text });
    }
    if (matches.length > 0) {
      xoilacMatchesCache = { time: Date.now(), matches };
    }
    return xoilacMatchesCache.matches;
  } catch (err) {
    console.error('[xoilac matches] error:', err.message);
    return xoilacMatchesCache.matches;
  }
}

function toKeywords(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2 && !['afc', 'the'].includes(w));
}

function matchTeam(textOrUrl, teamName) {
  const norm = (textOrUrl || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const kw = toKeywords(teamName);
  if (kw.length === 0) return false;
  if (kw.length === 1) return norm.includes(kw[0]);
  const matchCount = kw.filter(w => norm.includes(w)).length;
  return matchCount >= Math.min(2, kw.length);
}

function extractTeamsFromSlug(slug) {
  const clean = slug.replace(/^xoiche:/, '').replace(/-\d+$/, '');
  const parts = clean.split('-v-');
  if (parts.length >= 2) {
    return {
      home: parts[0].replace(/-/g, ' '),
      away: parts[1].replace(/-/g, ' ')
    };
  }
  return { home: '', away: '' };
}

async function fetchXoilacStreams(homeName, awayName) {
  try {
    const matches = await getXoilacMatches();
    const found = matches.find(m =>
      (matchTeam(m.url, homeName) || matchTeam(m.text, homeName)) &&
      (matchTeam(m.url, awayName) || matchTeam(m.text, awayName))
    );
    if (!found) return [];

    const pageRes = await httpClient.get(found.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
      },
      timeout: 4500
    });
    const html = pageRes.data;

    // 1. Lấy danh sách tên BLV
    const blvMap = new Map();
    const linkRegex = /<a[^>]+data-link=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRegex.exec(html)) !== null) {
      const idx = parseInt(lm[1], 10);
      const name = lm[2].replace(/<[^>]+>/g, '').trim();
      if (name) blvMap.set(idx, name);
    }

    // 2. Lấy cấu hình list_stream
    const streamMatch = html.match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
    if (!streamMatch) return [];

    let listStream;
    try {
      listStream = JSON.parse(streamMatch[1].replace(/\\\//g, '/'));
    } catch {
      return [];
    }

    // 3. Tải link m3u8 cho từng kênh BLV (tối đa 5 kênh)
    const channelPromises = listStream.slice(0, 6).map(async (channelList, idx) => {
      if (!Array.isArray(channelList) || channelList.length === 0) return null;
      const rawBlv = blvMap.get(idx);
      const blvName = rawBlv ? rawBlv : `Kênh ${idx + 1}`;

      for (const chanUrl of channelList.slice(0, 2)) {
        try {
          const res = await httpClient.get(chanUrl, {
            headers: {
              'User-Agent': IOS_UA,
              'Referer': `${XOILAC_BASE}/`
            },
            timeout: 3000
          });
          const m = res.data.match(/var\s+urlStream\s*=\s*["']([^"']+)["']/);
          if (m && m[1] && m[1].includes('.m3u8')) {
            return {
              name: `Xoilac - ${blvName}`,
              title: `${blvName} (HD)`,
              url: m[1],
              behaviorHints: {
                notWebReady: false
              }
            };
          }
        } catch {
          // Bỏ qua lỗi từng mirror
        }
      }
      return null;
    });

    const results = await Promise.all(channelPromises);
    return results.filter(Boolean);
  } catch (err) {
    console.error('[xoilac streams] error:', err.message);
    return [];
  }
}

/*
 * XOICHE STREAM FETCHER
 */
async function fetchXoicheStreams(slug) {
  try {
    let fixtureId = globalSlugToId.get(slug) || matchesCache.slugToFixtureId.get(slug);
    if (!fixtureId) {
      await getRawMatches();
      fixtureId = globalSlugToId.get(slug) || matchesCache.slugToFixtureId.get(slug);
    }

    if (!fixtureId) return [];

    const response = await httpClient.get(`${XOICHE}/api/matches/${encodeURIComponent(fixtureId)}/sources`, {
      headers: {
        ...HEADERS,
        'Accept': 'application/json',
        'Referer': `${XOICHE}/tran-dau/${encodeURIComponent(slug)}`
      },
      timeout: 3500 // Strict timeout: không để treo người dùng
    });

    const sources = response.data || {};
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

    return streams;
  } catch (err) {
    console.error('[xoiche api sources] error:', err.message);
    return [];
  }
}

/*
 * GET COMBINED STREAMS (XÔI CHÈ + XOILAC - CÓ CACHE & IN-FLIGHT DEDUP)
 */
async function getCombinedStreams(slug, homeName, awayName) {
  const cached = sourcesCache.get(slug);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  if (inFlightSources.has(slug)) {
    return inFlightSources.get(slug);
  }

  const task = (async () => {
    try {
      let home = homeName;
      let away = awayName;
      if (!home || !away) {
        const match = matchesCache.matches.find(m => m.id === `xoiche:${slug}`) ||
                      INITIAL_FALLBACK_MATCHES.find(m => m.id === `xoiche:${slug}`);
        if (match) {
          home = match.homeName;
          away = match.awayName;
        } else {
          const extracted = extractTeamsFromSlug(slug);
          home = extracted.home;
          away = extracted.away;
        }
      }

      // Tải song song cả 2 nguồn: Xôi Chè và Xoilac
      const [xoicheResult, xoilacResult] = await Promise.allSettled([
        fetchXoicheStreams(slug),
        fetchXoilacStreams(home, away)
      ]);

      const xoicheStreams = xoicheResult.status === 'fulfilled' ? xoicheResult.value : [];
      const xoilacStreams = xoilacResult.status === 'fulfilled' ? xoilacResult.value : [];

      const allStreams = [...xoicheStreams, ...xoilacStreams];

      // Loại bỏ trùng lặp theo URL
      const unique = [];
      const seen = new Set();
      for (const st of allStreams) {
        if (!seen.has(st.url)) {
          seen.add(st.url);
          unique.push(st);
        }
      }

      if (unique.length > 0) {
        sourcesCache.set(slug, unique, SOURCES_CACHE_TTL);
      }
      return unique;
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
    const match = matchesCache.matches.find(m => m.id === id) ||
                  INITIAL_FALLBACK_MATCHES.find(m => m.id === id);
    const homeName = match?.homeName || '';
    const awayName = match?.awayName || '';

    const streams = await getCombinedStreams(slug, homeName, awayName);
    return { streams };
  } catch (err) {
    console.error('[xoiche stream handler] error:', err.message);
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

// Tự động làm nóng cache ngay khi server khởi động
setTimeout(() => {
  refreshMatches().catch(() => {});
}, 150);

module.exports = {
  handleRequest,
  builder
};
