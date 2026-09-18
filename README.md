# HHPanda / Streamfree resolver

Resolves an HHPanda episode into a locally served, ordinary HLS playlist. The resolver obtains all episode metadata and temporary Streamfree values fresh on each run; it contains no captured nonce, checksum, cookie, timestamp, or media URL.

## Requirements

- Node.js 20+
- Google Chrome installed
- `ffprobe` is optional, for independent playback validation

## Install and run

```sh
npm install
DEBUG=1 node resolve.js "https://hhpanda.st/watch-gia-thien/tap-178-sv1.html"
```

Or use the launcher (the example episode is the default):

```sh
./run-resolver.sh
./run-resolver.sh "https://hhpanda.st/watch-gia-thien/tap-178-sv1.html"
```

The command prints JSON containing a loopback `streamUrl` and stays alive as the HLS gateway. Press Ctrl-C after the player is finished. The gateway is necessary because Streamfree's manifest and segment URLs are browser-transformed; it also supplies the CDN Referer/Origin itself.

```json
{
  "episodeUrl": "https://hhpanda.st/watch-gia-thien/tap-178-sv1.html",
  "embedUrl": "https://streamfree.vip/embed/v/NnqJZpDL",
  "streamUrl": "http://127.0.0.1:49152/stream.m3u8",
  "headers": {},
  "segmentCount": 123
}
```

Port, segment count, iframe ID, and all temporary credentials vary.

## Library integration

```js
const { resolveHHPandaEpisode, startStreamGateway } = require('./resolve');

const resolved = await resolveHHPandaEpisode(episodeUrl);
const { server, streamUrl } = await startStreamGateway(resolved);
// Return streamUrl from the Stremio addon, and close server when it expires.
```

For a deployed addon, incorporate the two gateway routes into the addon's existing HTTP server instead of opening a separate loopback port. Do not cache the signed bootstrap or protected manifest indefinitely; resolve it again when playback fails or the media URLs expire.

## Resolution flow

1. Parse the matching episode anchor for `data-post-id`, `data-ep`, and `data-sv`, and the selected player button for `data-type`.
2. Call HHPanda's AJAX player and extract its Streamfree iframe.
3. Fetch the iframe with a cookie jar and parse `uid`, bytecode, nonce, timestamps, checksum, IP field, and player IDs.
4. Open the legitimate page in Patchright/Chrome and narrowly instrument Streamfree's current player bundle. This captures the decrypted HLS timeline and calls the player's own per-fragment transform.
5. Remove the synthetic `SAMPLE-AES` declaration—the transformed CDN objects are clear MPEG-TS—and serve a conventional local playlist. Segment requests are proxied with Streamfree Origin and Referer.

The initially signed `/hls/*.m3u8` response is not a standard playable manifest: it contains an encrypted application payload. Returning that URL alone will not work in Stremio.
