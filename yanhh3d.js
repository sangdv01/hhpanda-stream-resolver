/**
 * yanhh3d.js - Module bóc tách dữ liệu và resolver cho YanHH3D (yanhh3d.men)
 */

'use strict';

const BASE_URL = 'https://yanhh3d.men';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36';

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
  const html = await fetchHTML(`${BASE_URL}/hoat-hinh-3d`);

  const cards = html.split(/class=["']flw-item["']/i).slice(1);
  const movies = [];
  const seen = new Set();

  for (const card of cards) {
    const hrefMatch = card.match(/<a\b[^>]*href=["'](https:\/\/yanhh3d\.men\/[^"']+)["'][^>]*class=["'][^"']*film-poster-ahref/i) ||
                      card.match(/<a\b[^>]*href=["'](https:\/\/yanhh3d\.men\/[^"']+)["']/i);
    if (!hrefMatch) continue;

    const href = hrefMatch[1];
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

  console.log(`[yanhh3d] Loaded ${movies.length} movies from catalog`);
  return movies;
}

/**
 * Lấy chi tiết phim và danh sách tập
 */
async function fetchMetaYan(seriesUrl) {
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
  const watchMatch = html.match(/href=["'](https:\/\/yanhh3d\.men\/[^"']*\/tap-\d+[^"']*)["']/i);
  let episodes = [];

  if (watchMatch) {
    const watchUrl = watchMatch[1];
    const watchHtml = await fetchHTML(watchUrl);

    const epRegex = /<a\b[^>]*href=["'](https:\/\/yanhh3d\.men\/[^"']*\/tap-(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    let m;

    while ((m = epRegex.exec(watchHtml)) !== null) {
      const epUrl = m[1];
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
 * Trích xuất link manifest plain pU từ iframe rptstream
 */
async function resolveEmbedPlayer(embedUrl) {
  try {
    const res = await fetch(embedUrl, {
      headers: { 'Referer': BASE_URL, 'User-Agent': DEFAULT_UA }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const obfMatch = html.match(/data-obf=["']([^"']+)["']/i);
    if (!obfMatch) return null;
    const data = JSON.parse(Buffer.from(obfMatch[1], 'base64').toString('utf8'));
    return data.pU || null;
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
  console.log('[yanhh3d] resolving streams for:', episodeUrl);

  const cleanUrl = episodeUrl.replace('/sever2/', '/');
  const tmUrl = cleanUrl;
  const subUrl = cleanUrl.replace('https://yanhh3d.men/', 'https://yanhh3d.men/sever2/');

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

    for (const b of btns) {
      const text = b.replace(/<[^>]+>/g, '').trim();
      const srcMatch = b.match(/data-src=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const src = srcMatch[1];

      // Ưu tiên 4K chính (LINK5), sau đó LINK6
      if (text === '4K' && !link4k) {
        link4k = src;
      } else if (text === '4K-' && !link4k) {
        link4k = src;
      }

      // Ưu tiên 1080 chính (LINK1), sau đó LINK4
      if (text === '1080' && !link1080) {
        link1080 = src;
      } else if (text === '1080-' && !link1080) {
        link1080 = src;
      }
    }

    return { link4k, link1080 };
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

  console.log(`[yanhh3d] Resolved ${results.length} streams (4K / 1080P)`);
  return results;
}

module.exports = {
  fetchTrendingYan,
  fetchMetaYan,
  resolveYanStreams,
  findTsSyncOffset
};
