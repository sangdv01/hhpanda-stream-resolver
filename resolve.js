#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { chromium } = require('patchright');

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const debug = (...args) => { if (process.env.DEBUG === '1') console.error('[debug]', ...args); };

class StageError extends Error {
  constructor(stage, message, details = {}) {
    super(`${stage}: ${message}`);
    this.name = 'StageError';
    this.stage = stage;
    this.details = details;
  }
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  setFromHeaders(headers, url) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    debug('cookies accepted for', new URL(url).hostname, [...this.cookies.keys()]);
  }
  header() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  get(name) { return this.cookies.get(name); }
}

function preview(text, max = 240) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, max);
}

async function requestText(url, { stage, headers = {}, jar, ...options } = {}) {
  const requestHeaders = { 'user-agent': DEFAULT_UA, ...headers };
  if (jar?.header()) requestHeaders.cookie = jar.header();
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', ...options, headers: requestHeaders });
  } catch (error) {
    throw new StageError(stage, error.message, { url });
  }
  jar?.setFromHeaders(response.headers, response.url);
  const text = await response.text();
  if (!response.ok) {
    throw new StageError(stage, `HTTP ${response.status}`, { url, status: response.status, preview: preview(text) });
  }
  debug(stage, response.status, response.url, preview(text, 100));
  return { response, text };
}

function decodeEntities(value) {
  return value.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return result;
}

function parseEpisode(html, episodeUrl) {
  const target = new URL(episodeUrl).href.replace(/\/$/, '');
  const anchors = [...html.matchAll(/<a\b[^>]*\bdata-post-id\s*=\s*["'][^"']+["'][^>]*>/gi)]
    .map(match => attributes(match[0]));
  const episode = anchors.find(a => {
    try { return new URL(a.href, episodeUrl).href.replace(/\/$/, '') === target; } catch { return false; }
  });
  if (!episode?.['data-post-id'] || !episode['data-ep'] || !episode['data-sv']) {
    throw new StageError('parse episode', 'active episode metadata was not found', { url: episodeUrl });
  }
  const serverChooser = html.match(/<div[^>]+id=["']halim-ajax-list-server["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const playerType = attributes(serverChooser.match(/<[^>]+class=["'][^"']*\bget-eps\b[^"']*["'][^>]*>/i)?.[0] || '')['data-type'];
  if (!playerType) throw new StageError('parse episode', 'player type was not found');
  return {
    postId: episode['data-post-id'],
    chapter: episode['data-ep'],
    server: episode['data-sv'],
    playerType
  };
}

async function resolveHHPandaPlayer(episodeUrl, episode) {
  const endpoint = new URL('/player/player.php', episodeUrl);
  endpoint.search = new URLSearchParams({
    action: 'dox_ajax_player', post_id: episode.postId,
    chapter_st: episode.chapter, type: episode.playerType, sv: episode.server
  });
  const { text } = await requestText(endpoint, {
    stage: 'HHPanda player',
    headers: { referer: episodeUrl, 'x-requested-with': 'XMLHttpRequest' }
  });
  const iframe = text.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!iframe) throw new StageError('HHPanda player', 'iframe URL was not present', { preview: preview(text) });
  return new URL(decodeEntities(iframe), endpoint).href;
}

function parseStreamfreeBootstrap(html, jar) {
  const bytecode = html.match(/<meta\b[^>]*name=["']bytecode["'][^>]*>/i);
  const player = html.match(/<div\b[^>]*id=["']hrm-player["'][^>]*>/i);
  const meta = bytecode ? attributes(bytecode[0]) : {};
  const data = player ? attributes(player[0]) : {};
  if (!meta.content || !data['data-video-id']) {
    throw new StageError('Streamfree bootstrap', 'bytecode or player data was not found', { preview: preview(html) });
  }
  return {
    uid: jar.get('uid'), bytecode: meta.content, id: data['data-id'], videoId: data['data-video-id'],
    nonce: data['data-nonce'], time: data['data-time'], startTime: data['data-starttime'],
    checksum: data['data-checksum'], uip: data['data-uip']
  };
}

async function createStreamfreeSession(embedUrl, episodeUrl) {
  const jar = new CookieJar();
  const { text } = await requestText(embedUrl, {
    stage: 'Streamfree bootstrap', jar,
    headers: { referer: episodeUrl, accept: 'text/html,application/xhtml+xml' }
  });
  return { jar, bootstrap: parseStreamfreeBootstrap(text, jar) };
}

function patchedBundle(body) {
  const playlistMarker = /(_0x6284ff=_0x2843c3\[[^;]+?\]\(\))/;
  const helperMarker = "_0x541b4a=_0x5de79d['v']";
  if (!playlistMarker.test(body) || !body.includes(helperMarker)) {
    throw new StageError('Streamfree instrumentation', 'known player markers changed');
  }
  body = body.replace(playlistMarker, '$1,document.documentElement.setAttribute("data-decoded-playlist",_0x6284ff)');
  body = body.replaceAll('_0x59b8ac(_0x296260)', 'void 0');
  const bridge = `,globalThis.__sfOriginal=_0x541b4a[1],_0x541b4a[1]=async function(a,b){if(!globalThis.__sfTemplate){globalThis.__sfState=a;globalThis.__sfTemplate=Object.assign(Object.create(Object.getPrototypeOf(b)),b);document.documentElement.setAttribute("data-helper-ready","1")}return globalThis.__sfOriginal(a,b)},document.addEventListener("streamfree-decode-fragment",async function(){try{var u=document.documentElement.getAttribute("data-encoded-url"),t=globalThis.__sfTemplate,q=Object.assign(Object.create(Object.getPrototypeOf(t)),t),n=Number(new URL(u).searchParams.get("i"));q._url=u;q.relurl=u;q.sn=n;var r=await globalThis.__sfOriginal(globalThis.__sfState,q);document.documentElement.setAttribute("data-decoded-url",r._url)}catch(x){document.documentElement.setAttribute("data-decoded-url","ERROR:"+x.message)}})`;
  return body.replace(helperMarker, helperMarker + bridge);
}

async function createStreamfreeBrowser() {

  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || undefined,
    headless: process.env.HEADLESS === '1'
  });


  return browser;
}
async function resolveStreamfreeSource(
  episodeUrl,
  embedUrl,
  sharedBrowser = null
) {
  const browser = sharedBrowser || await createStreamfreeBrowser();
  const ownsBrowser = !sharedBrowser;
  let context = null;

  try {
    context = await browser.newContext({
      userAgent: DEFAULT_UA
    });

    await context.route('**/public/static/app.*.js', async route => {
      const response = await route.fetch();

      await route.fulfill({
        response,
        body: patchedBundle(await response.text())
      });
    });

    const page = await context.newPage();

    debug('opening real HHPanda page in Patchright');

    await page.goto(episodeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    const deadline = Date.now() + 45_000;
    let frame;

    while (Date.now() < deadline) {
      frame = page.frames().find(candidate =>
        candidate.url().startsWith(
          new URL(embedUrl).origin + '/embed/'
        )
      );

      if (frame) {
        const ready = await frame.evaluate(() =>
          document.documentElement.hasAttribute(
            'data-decoded-playlist'
          ) &&
          document.documentElement.hasAttribute(
            'data-helper-ready'
          )
        ).catch(() => false);

        if (ready) break;
      }

      await page.waitForTimeout(250);
    }

    if (!frame) {
      throw new StageError(
        'Streamfree browser',
        'embed frame did not load'
      );
    }

    const result = await frame.evaluate(async () => {
      const playlist =
        document.documentElement.getAttribute(
          'data-decoded-playlist'
        );

      if (!playlist) {
        throw new Error(
          'decoded playlist did not appear'
        );
      }

      const virtualUrls = playlist
        .split(/\r?\n/)
        .filter(line =>
          /^https?:\/\//.test(line.trim())
        );

      const mappings = [];

      for (const virtualUrl of virtualUrls) {
        document.documentElement.removeAttribute(
          'data-decoded-url'
        );

        document.documentElement.setAttribute(
          'data-encoded-url',
          virtualUrl
        );

        document.dispatchEvent(
          new Event('streamfree-decode-fragment')
        );

        for (
          let attempt = 0;
          attempt < 200 &&
          !document.documentElement.hasAttribute(
            'data-decoded-url'
          );
          attempt++
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, 10)
          );
        }

        const directUrl =
          document.documentElement.getAttribute(
            'data-decoded-url'
          );

        if (
          !directUrl ||
          directUrl.startsWith('ERROR:')
        ) {
          throw new Error(
            `segment transform failed: ${directUrl || 'timeout'}`
          );
        }

        mappings.push([
          virtualUrl,
          directUrl
        ]);
      }

      // ===== JWPLAYER RUNTIME DEBUG =====
      let qualityLevels = [];
      let playlistItem = null;
      let playerConfig = null;

      try {
        if (typeof window.jwplayer === 'function') {
          const player = window.jwplayer();

          if (player) {
            try {
              qualityLevels =
                player.getQualityLevels?.() || [];
            } catch {}

            try {
              playlistItem =
                player.getPlaylistItem?.() ||
                player.getItem?.() ||
                null;
            } catch {}

            try {
              playerConfig =
                player.getConfig?.() || null;
            } catch {}
          }
        }
      } catch {}

      console.log('');
      console.log('===== JWPLAYER RUNTIME =====');
      console.log('--- QUALITY LEVELS ---');
      console.log(
        JSON.stringify(
          qualityLevels,
          null,
          2
        )
      );
      console.log('--- PLAYLIST ITEM ---');
      console.log(
        JSON.stringify(
          playlistItem,
          null,
          2
        )
      );
      console.log('--- PLAYER CONFIG ---');
      console.log(
        JSON.stringify(
          playerConfig,
          null,
          2
        )
      );
      console.log(
        '===== END JWPLAYER RUNTIME ====='
      );
      console.log('');

      return {
        playlist,
        mappings,
        qualityLevels,
        playlistItem,
        playerConfig
      };
    });

    console.log('');
    console.log('===== JWPLAYER RUNTIME =====');
    console.log('--- QUALITY LEVELS ---');
    console.log(
      JSON.stringify(
        result.qualityLevels,
        null,
        2
      )
    );
    console.log('--- PLAYLIST ITEM ---');
    console.log(
      JSON.stringify(
        result.playlistItem,
        null,
        2
      )
    );
    console.log('--- PLAYER CONFIG ---');
    console.log(
      JSON.stringify(
        result.playerConfig,
        null,
        2
      )
    );
    console.log(
      '===== END JWPLAYER RUNTIME ====='
    );
    console.log('');

    if (!result.mappings.length) {
      throw new StageError(
        'Streamfree browser',
        'decoded playlist had no media segments'
      );
    }

    debug(
      'resolved',
      result.mappings.length,
      'media segments'
    );

    return result;
  } catch (error) {
    if (error instanceof StageError) {
      throw error;
    }

    throw new StageError(
      'Streamfree browser',
      error.message
    );
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    if (ownsBrowser) {
      await browser.close();
    }
  }
}
function buildLocalPlaylist(playlist, mappings, baseUrl) {
  const indexes = new Map(mappings.map(([virtual], index) => [virtual.trim(), index]));
  return playlist.split(/\r?\n/)
    .filter(line => !line.startsWith('#EXT-X-KEY:'))
    .map(line => indexes.has(line.trim()) ? `${baseUrl}/segment/${indexes.get(line.trim())}.ts` : line)
    .join('\n');
}

async function startStreamGateway(resolution, { host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      if (requestUrl.pathname === '/stream.m3u8') {
        const requestHost = req.headers.host || `127.0.0.1:${server.address().port}`;
        const origin = `http://${requestHost}`;
        const body = buildLocalPlaylist(resolution.playlist, resolution.mappings, origin);
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        return res.end(body);
      }
      const match = requestUrl.pathname.match(/^\/segment\/(\d+)\.ts$/);
      if (!match || !resolution.mappings[Number(match[1])]) { res.writeHead(404); return res.end('not found'); }
      const directUrl = resolution.mappings[Number(match[1])][1];
      const upstreamHeaders = {
        'user-agent': DEFAULT_UA, referer: resolution.embedUrl,
        origin: new URL(resolution.embedUrl).origin
      };
      if (req.headers.range) upstreamHeaders.range = req.headers.range;
      const upstream = await fetch(directUrl, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: upstreamHeaders });
      const headers = { 'content-type': upstream.headers.get('content-type') || 'video/mp2t', 'access-control-allow-origin': '*' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name); if (value) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      if (req.method === 'HEAD' || !upstream.body) return res.end();
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (error) {
      debug('gateway error', error.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('upstream error');
    }
  });
  await new Promise((resolve, reject) => server.listen(port, host, resolve).once('error', reject));
  return { server, streamUrl: `http://${host}:${server.address().port}/stream.m3u8` };
}

async function resolveHHPandaEpisode(episodeUrl, playerType = null, sharedBrowser = null) {
  const normalized = new URL(episodeUrl).href;
  const { text: html } = await requestText(normalized, { stage: 'HHPanda episode' });
  const episode = parseEpisode(html, normalized);

  if (playerType) {
    episode.playerType = playerType;
  }

  // Force server 2 = Lồng tiếng
  episode.server = 2;

  debug('episode metadata', episode);

  const embedUrl = await resolveHHPandaPlayer(normalized, episode);
  const { bootstrap } = await createStreamfreeSession(embedUrl, normalized);

  debug('bootstrap', {
    videoId: bootstrap.videoId,
    hasUid: Boolean(bootstrap.uid),
    hasBytecode: Boolean(bootstrap.bytecode),
    hasNonce: Boolean(bootstrap.nonce),
    hasChecksum: Boolean(bootstrap.checksum)
  });

  const source = await resolveStreamfreeSource(normalized, embedUrl, sharedBrowser);

  return { episodeUrl: normalized, embedUrl, bootstrap, ...source };
}

async function main() {
  const episodeUrl = process.argv[2];
  if (!episodeUrl) throw new Error('Usage: node resolve.js <HHPanda episode URL>');
  const resolution = await resolveHHPandaEpisode(episodeUrl);
  const gateway = await startStreamGateway({ ...resolution, embedUrl: resolution.embedUrl });
  const output = {
    episodeUrl: resolution.episodeUrl,
    embedUrl: resolution.embedUrl,
    streamUrl: gateway.streamUrl,
    headers: {},
    segmentCount: resolution.mappings.length
  };
  console.log(JSON.stringify(output, null, 2));
  console.error('Resolver gateway is running; press Ctrl-C to stop.');
  const stop = () => gateway.server.close(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

module.exports = {
  CookieJar, parseEpisode, resolveHHPandaPlayer, createStreamfreeSession,
  parseStreamfreeBootstrap, createStreamfreeBrowser,
  resolveStreamfreeSource, resolveHHPandaEpisode,
  buildLocalPlaylist, startStreamGateway
};

if (require.main === module) main().catch(error => {
  const details = error.details || {};
  console.error(JSON.stringify({ error: error.message, stage: error.stage, ...details }, null, 2));
  process.exitCode = 1;
});
