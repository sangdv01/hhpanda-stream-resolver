/**
 * yanhh3d.js - Module bóc tách dữ liệu và resolver cho YanHH3D (yanhh3d.men)
 */

'use strict';

const BITLY_URL = 'https://bit.ly/yanhh3d';
let cachedBaseUrl = 'https://yanhh3d.men';
let lastDomainCheck = 0;
const DOMAIN_CACHE_TTL = 15 * 60 * 1000; // 15 phút kiểm tra redirect 1 lần
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36';

/**
 * Tự động phân giải domain mới nhất từ link chính https://bit.ly/yanhh3d
 */
async function getBaseUrl(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedBaseUrl && (now - lastDomainCheck < DOMAIN_CACHE_TTL)) {
    return cachedBaseUrl;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(BITLY_URL, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': DEFAULT_UA },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.url && res.url.startsWith('http')) {
      const parsed = new URL(res.url);
      if (parsed.origin && !parsed.origin.includes('bit.ly')) {
        if (parsed.origin !== cachedBaseUrl) {
          console.log(`[yanhh3d] Domain automatically updated: ${cachedBaseUrl} -> ${parsed.origin}`);
          cachedBaseUrl = parsed.origin;
        }
        lastDomainCheck = now;
        return cachedBaseUrl;
      }
    }
  } catch (err) {
    console.warn(`[yanhh3d] Domain lookup via ${BITLY_URL} failed (${err.message}). Using fallback: ${cachedBaseUrl}`);
  }

  lastDomainCheck = now;
  return cachedBaseUrl;
}

/**
 * Chuẩn hóa URL sang domain hiện tại (giúp các bookmark/thư viện cũ vẫn tự trỏ sang domain mới)
 */
async function normalizeYanUrl(rawUrl) {
  const base = await getBaseUrl();
  try {
    const u = new URL(String(rawUrl || '').replace(/^https?:\/+(?=[^/])/, 'https://'));
    return `${base}${u.pathname}${u.search}`;
  } catch (e) {
    return rawUrl;
  }
}

/**
 * Nhận diện ID có thuộc về nguồn YanHH3D hay không
 */
function isYanId(id) {
  if (!id) return false;
  const idStr = String(id).toLowerCase();
  if (idStr.includes('hhpanda.st') || idStr.includes('hhpanda')) return false;
  if (idStr.includes('yanhh3d')) return true;
  try {
    const curHost = new URL(cachedBaseUrl).hostname.toLowerCase();
    if (idStr.includes(curHost)) return true;
  } catch (e) {}
  return idStr.startsWith('http://') || idStr.startsWith('https://');
}

function getText(html) {
  return String(html || '')
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
  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/**
 * Lấy danh sách phim thịnh hành / mới cập nhật từ YanHH3D
 */
async function fetchTrendingYan() {
  console.log('[yanhh3d] fetching trending catalog...');
  const baseUrl = await getBaseUrl();
  const html = await fetchHTML(`${baseUrl}/hoat-hinh-3d`);

  const cards = html.split(/class=["']flw-item["']/i).slice(1);
  const movies = [];
  const seen = new Set();

  for (const card of cards) {
    const hrefMatch = card.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*film-poster-ahref/i) ||
                      card.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    const href = new URL(hrefMatch[1], baseUrl).href;
    if (seen.has(href)) continue;
    seen.add(href);

    const titleMatch = card.match(/class=["'][^"']*\bdynamic-name\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ||
                       card.match(/title=["']([^"']+)["']/i);
    const title = titleMatch ? getText(titleMatch[1]) : href.split('/').filter(Boolean).pop();

    const posterMatch = card.match(/data-src=["']([^"']+)["']/i) || card.match(/src=["']([^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1] : undefined;

    const rateMatch = card.match(/class=["'][^"']*\btick-rate\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const dubMatch = card.match(/class=["'][^"']*\btick-dub\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const rateText = rateMatch ? getText(rateMatch[1]) : '';
    const dubText = dubMatch ? getText(dubMatch[1]) : '';

    const descriptionParts = ['YanHH3D'];
    if (rateText) descriptionParts.push(rateText);
    if (dubText) descriptionParts.push(dubText);

    movies.push({
      id: href,
      name: title,
      poster,
      logo: poster,
      background: poster,
      description: descriptionParts.join(' • ')
    });
  }

  console.log(`[yanhh3d] Loaded ${movies.length} movies from catalog (${baseUrl})`);
  return movies;
}

/**
 * Lấy chi tiết phim và danh sách tập
 */
async function fetchMetaYan(seriesUrl) {
  const baseUrl = await getBaseUrl();
  seriesUrl = await normalizeYanUrl(seriesUrl);
  console.log('[yanhh3d] fetching meta for:', seriesUrl);
  const html = await fetchHTML(seriesUrl);

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                     html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = titleMatch ? getText(titleMatch[1]) : seriesUrl.split('/').filter(Boolean).pop();

  const posterMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<img\b[^>]*class=["'][^"']*film-poster-img[^"']*["'][^>]*src=["']([^"']+)["']/i);
  const poster = posterMatch ? posterMatch[1] : undefined;

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                    html.match(/class=["'][^"']*\bfilm-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const description = descMatch ? getText(descMatch[1]) : `${title} • Hoạt hình Trung Quốc 3D (YanHH3D)`;

  // Tìm link trang xem tập đầu tiên để lấy danh sách toàn bộ các tập
  const watchMatch = html.match(/href=["']((?:https?:\/\/[^"'\/]+)?\/[^"']*\/tap-\d+[^"']*)["']/i);
  let episodes = [];

  if (watchMatch) {
    const watchUrl = new URL(watchMatch[1], baseUrl).href;
    const watchHtml = await fetchHTML(watchUrl);

    const epRegex = /<a\b[^>]*href=["']((?:https?:\/\/[^"'\/]+)?\/[^"']*\/tap-(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    let m;

    while ((m = epRegex.exec(watchHtml)) !== null) {
      const epUrl = new URL(m[1], baseUrl).href;
      const epNum = Number(m[2]);
      if (!seen.has(epNum)) {
        seen.add(epNum);
        episodes.push({
          id: epUrl,
          title: `Tập ${epNum}`,
          season: 1,
          episode: epNum
        });
      }
    }

    episodes.sort((a, b) => a.episode - b.episode);
  }

  console.log(`[yanhh3d] Loaded ${episodes.length} episodes for ${title}`);

  return {
    id: seriesUrl,
    type: 'series',
    name: title,
    poster,
    background: poster,
    logo: poster,
    description,
    genres: ['Hoạt Hình', 'Trung Quốc', '3D', 'YanHH3D'],
    videos: episodes
  };
}

/**
 * Trích xuất link manifest plain pU hoặc stream m3u8 từ iframe rptstream
 */
async function resolveEmbedPlayer(embedUrl) {
  if (!embedUrl) return null;
  const baseUrl = await getBaseUrl();
  try {
    const res = await fetch(embedUrl, {
      headers: { 'Referer': `${baseUrl}/`, 'User-Agent': DEFAULT_UA }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. data-obf (Base64 JSON)
    const obfMatch = html.match(/data-obf=["']([^"']+)["']/i);
    if (obfMatch) {
      try {
        const data = JSON.parse(Buffer.from(obfMatch[1], 'base64').toString('utf8'));
        if (data.pU || data.sU) return data.pU || data.sU;
      } catch (e) {}
    }

    // 2. data-stream-url
    const streamUrlMatch = html.match(/data-stream-url=["']([^"']+)["']/i);
    if (streamUrlMatch && streamUrlMatch[1].includes('.m3u8')) {
      return streamUrlMatch[1];
    }

    // 3. window.streamURL / streamUrl
    const winMatch = html.match(/(?:window\.)?stream(?:URL|Url)\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (winMatch) return winMatch[1];

    // 4. var cccc = "..." or file: "..."
    const ccccMatch = html.match(/var\s+\w+\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (ccccMatch) return ccccMatch[1];

    const fileMatch = html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (fileMatch) return fileMatch[1];

    // 5. Fallback link m3u8 chứa /stream/ hoặc /stream-plain
    const streamM3u8Match = html.match(/["'](https?:\/\/[^"']*\/stream(?:-plain)?\/?[^"']*)["']/i);
    if (streamM3u8Match) return streamM3u8Match[1];

    return null;
  } catch (err) {
    console.error('[yanhh3d] resolveEmbedPlayer error:', err.message);
    return null;
  }
}

/**
 * Tìm vị trí bắt đầu của gói tin MPEG-TS (byte 0x47 cách nhau 188 bytes)
 */
function findTsSyncOffset(buf) {
  for (let i = 0; i < 1000 && i + 376 < buf.length; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
      return i;
    }
  }
  return 0;
}

/**
 * Phân giải tất cả các luồng 1080p và 4K (Thuyết Minh + Vietsub) cho một tập phim
 */
async function resolveYanStreams(episodeUrl) {
  const baseUrl = await getBaseUrl();
  episodeUrl = await normalizeYanUrl(episodeUrl);
  console.log('[yanhh3d] resolving streams for:', episodeUrl);

  const cleanUrl = episodeUrl.replace('/sever2/', '/');
  const tmUrl = cleanUrl;
  const subUrl = cleanUrl.replace(/https?:\/\/[^/]+\//, `${baseUrl}/sever2/`);

  // Tải đồng thời cả 2 trang Thuyết Minh và Vietsub
  const [tmHtmlRes, subHtmlRes] = await Promise.allSettled([
    fetchHTML(tmUrl),
    fetchHTML(subUrl)
  ]);

  const tmHtml = tmHtmlRes.status === 'fulfilled' ? tmHtmlRes.value : '';
  const subHtml = subHtmlRes.status === 'fulfilled' ? subHtmlRes.value : '';

  function parseQualityButtons(html) {
    const btns = html.match(/<[^>]+id=["']sv_[^"']+["'][^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
    let link4k = null;
    let link1080 = null;
    let linkHd = null;
    let linkOther = null;

    for (const b of btns) {
      const text = b.replace(/<[^>]+>/g, '').trim();
      const srcMatch = b.match(/data-src=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const src = srcMatch[1];
      const upper = text.toUpperCase();

      // Chỉ chọn server rptstream hoặc có link m3u8
      if (!src.includes('rptstream.xyz') && !src.includes('.m3u8')) {
        continue;
      }

      if (upper.includes('4K') || upper.includes('2160')) {
        if (!link4k || text === '4K') link4k = src;
      } else if (upper.includes('1080')) {
        if (!link1080 || text === '1080') link1080 = src;
      } else if (upper.includes('HD') || upper.includes('720')) {
        if (!linkHd || text === 'HD') linkHd = src;
      } else {
        if (!linkOther) linkOther = src;
      }
    }

    return { link4k, link1080, linkHd, linkOther };
  }

  const tmButtons = parseQualityButtons(tmHtml);
  const subButtons = parseQualityButtons(subHtml);

  // Giải mã song song các link embed tìm được
  const [tm4k, tm1080, sub4k, sub1080] = await Promise.all([
    tmButtons.link4k ? resolveEmbedPlayer(tmButtons.link4k) : Promise.resolve(null),
    tmButtons.link1080 ? resolveEmbedPlayer(tmButtons.link1080) : Promise.resolve(null),
    subButtons.link4k ? resolveEmbedPlayer(subButtons.link4k) : Promise.resolve(null),
    subButtons.link1080 ? resolveEmbedPlayer(subButtons.link1080) : Promise.resolve(null)
  ]);

  const results = [];

  if (tm4k) {
    results.push({
      quality: '4K',
      type: 'Thuyết Minh',
      name: '[YanHH3D]\n4K',
      title: 'YanHH3D • 4K • Thuyết Minh',
      playlistUrl: tm4k
    });
  }

  if (tm1080) {
    results.push({
      quality: '1080P',
      type: 'Thuyết Minh',
      name: '[YanHH3D]\n1080P',
      title: 'YanHH3D • 1080P • Thuyết Minh',
      playlistUrl: tm1080
    });
  }

  if (sub4k) {
    results.push({
      quality: '4K',
      type: 'Phụ Đề',
      name: '[YanHH3D]\n4K',
      title: 'YanHH3D • 4K • Phụ Đề (Vietsub)',
      playlistUrl: sub4k
    });
  }

  if (sub1080) {
    results.push({
      quality: '1080P',
      type: 'Phụ Đề',
      name: '[YanHH3D]\n1080P',
      title: 'YanHH3D • 1080P • Phụ Đề (Vietsub)',
      playlistUrl: sub1080
    });
  }

  // Fallback nếu không có 4K hoặc 1080P (như trailer hoặc tập phim cũ chỉ có bản HD)
  if (results.length === 0) {
    const [tmHd, subHd] = await Promise.all([
      tmButtons.linkHd ? resolveEmbedPlayer(tmButtons.linkHd) : (tmButtons.linkOther ? resolveEmbedPlayer(tmButtons.linkOther) : Promise.resolve(null)),
      subButtons.linkHd ? resolveEmbedPlayer(subButtons.linkHd) : (subButtons.linkOther ? resolveEmbedPlayer(subButtons.linkOther) : Promise.resolve(null))
    ]);

    if (tmHd) {
      results.push({
        quality: 'HD',
        type: 'Thuyết Minh',
        name: '[YanHH3D]\nHD',
        title: 'YanHH3D • HD • Thuyết Minh',
        playlistUrl: tmHd
      });
    }

    if (subHd) {
      results.push({
        quality: 'HD',
        type: 'Phụ Đề',
        name: '[YanHH3D]\nHD',
        title: 'YanHH3D • HD • Phụ Đề (Vietsub)',
        playlistUrl: subHd
      });
    }
  }

  console.log(`[yanhh3d] Resolved ${results.length} streams (4K / 1080P)`);
  return results;
}

module.exports = {
  getBaseUrl,
  normalizeYanUrl,
  isYanId,
  fetchTrendingYan,
  fetchMetaYan,
  resolveYanStreams,
  findTsSyncOffset
};
