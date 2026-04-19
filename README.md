# Waterfall Tools

Waterfall Tools is a fast, zero-bloat library for parsing, analyzing, and visualizing network waterfalls in the browser or Node.js. It normalizes a wide range of network trace formats — PCAP, Netlog, Chrome Trace, Perfetto, CDP, WebPageTest JSON, HAR — into a single Extended HAR intermediate, then renders them via `<canvas>` in WebPageTest style without building thousands of DOM nodes.

## Features

- **Format agnostic.** Parses HAR, Netlog, Chrome Trace, Perfetto protobuf, CDP, WebPageTest JSON, and raw TCPDUMP captures (with automatic TLS/QUIC decryption, bandwidth estimation, per-chunk download timing, and HTTP/2 & HTTP/3 priority extraction).
- **Unified API.** `WaterfallTools` auto-detects the input format and produces a consistent Extended HAR payload regardless of source.
- **Isomorphic.** The core runs in Node.js and modern browsers with no polyfills — binary and cryptographic operations use `Uint8Array`, `DataView`, `WebCrypto`, and `DecompressionStream`.
- **Canvas renderer.** Scales cleanly from 50 to 50,000 requests without DOM thrashing.
- **Offline (PWA).** The standalone viewer registers a Service Worker and works offline.
- **Response body inspection.** When bodies are available (Netlog decoded bytes, wptagent nested `_bodies.zip`, tcpdump captures, or standard HAR `response.content.text`), the viewer syntax-highlights text formats (HTML, CSS, JS, JSON, XML) and renders images inline. For tcpdump imports, `gzip`, `deflate`, `br`, and `zstd` content-encoded bodies are automatically decompressed via native `DecompressionStream` with pure-JS fallbacks (`brotli`, `fzstd`) where the native stream isn't available.
- **Optional CORS fetch proxy.** A single-file [Cloudflare Worker](cloudflare-worker/) provides a CORS-safe fallback for URL imports. It proxies only recognised waterfall-tools formats, forwards the caller's IP upstream (non-anonymizing), blocks obvious SSRF targets, and applies a per-IP failure rate limit. No bindings — paste `cloudflare-worker/worker.js` into the Cloudflare dashboard.

For the design, module layout, and conventions, see [Docs/Architecture.md](Docs/Architecture.md).

## Installation

```bash
npm install waterfall-tools
```

To host the bundled viewer (see [Hosting the viewer](#hosting-the-viewer)) also install the Chrome DevTools frontend as a peer dependency:

```bash
npm install waterfall-tools @chrome-devtools/index
```

The DevTools bundle is ~80 MB of prebuilt third-party code kept out of the waterfall-tools tarball on purpose — CLI-only and library-only users don't download it. The peer dependency is declared optional, so `npm install waterfall-tools` alone completes without errors or warnings.

## API usage

The library is pure ESM. Your project needs `"type": "module"` or an ESM-aware bundler. The single entry point is the `WaterfallTools` class.

> [!NOTE]
> **Optional asset bundles.** The build emits `tcpdump-[hash].js` (packet capture pipeline) and `decompress-[hash].js` (tcpdump Brotli/zstd fallbacks) as separate dynamically-loaded chunks alongside `waterfall-[hash].js` and its proxy stub `waterfall-tools.es.js`. For a minimal integration you can host just the core payload and stub; the library falls back gracefully if the supplement chunks aren't reachable.

### Process a local file (Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools';

const wt = new WaterfallTools();
await wt.loadFile('./trace.cap.gz');  // format auto-detected
const har = wt.getHar();

console.log(`HAR has ${har.log.entries.length} requests`);
```

### Process a stream (browser or Node.js)

`loadStream` requires `options.format` — it cannot sniff a raw stream without buffering.

```javascript
import { WaterfallTools } from 'waterfall-tools';

const wt = new WaterfallTools();
await wt.loadStream(fileStream, {
    format: 'tcpdump',
    isGz: true,
    keyLogInput: keyLogStream  // optional TLS keylog for pcap decryption
});
const har = wt.getHar();
```

### Process an in-memory buffer (browser or Node.js)

Use when you already have the full file as `Buffer`, `ArrayBuffer`, or `Uint8Array`. Format is sniffed from the bytes.

```javascript
const wt = new WaterfallTools();
await wt.loadBuffer(await uploadedFile.arrayBuffer());
```

### Progress tracking

Pass `onProgress` to keep the UI responsive on large files:

```javascript
await wt.loadBuffer(buffer, {
    onProgress: (phase, percent) => {
        console.log(`${phase} — ${percent}%`);
    }
});
```

`phase` is a human-readable stage label (`"Reading packets..."`, `"Decrypting TLS..."`, `"Building waterfall..."`, etc.). `percent` is 0–100. The tcpdump parser reports five distinct phases; other parsers report byte-consumption progress through their single streaming pass.

### Load from a URL (browser or Node.js)

```javascript
const wt = new WaterfallTools();
await wt.loadUrl('https://example.com/trace.json.gz');
```

### Retrieve extracted assets (screenshots, traces, netlogs)

Returns an isomorphic handle — a Blob URL in the browser (`{url, mimeType}`), a raw byte buffer in Node (`{buffer}`). Assets are extracted on demand from the parsed OPFS-backed archive rather than inflating everything into memory up front.

```javascript
const resource = await wt.getPageResource('page_1_0_1', 'screenshot');
// resourceType: 'screenshot' | 'trace' | 'netlog' | 'lighthouse' | ...
if (resource?.url) document.querySelector('img').src = resource.url;
if (resource?.buffer) fs.writeFileSync('screen.jpg', resource.buffer);
```

### Render to a container (browser)

```javascript
import { WaterfallTools } from 'waterfall-tools';

const wt = new WaterfallTools();
await wt.loadUrl('https://example.com/trace.json.gz');

// Start from the canonical defaults; override what you need.
const options = {
    ...WaterfallTools.getDefaultOptions(),
    minWidth: 800
};

await wt.renderTo(document.getElementById('waterfall-container'), options);
```

`WaterfallTools.getDefaultOptions()` returns the canonical render configuration:

```javascript
{
    pageId: null,            // specific page to render (defaults to the first page)
    connectionView: false,   // render per-connection rather than per-request
    thumbnailView: false,    // minimal thumbnail rendering
    minWidth: 0,             // minimum canvas width in px
    startTime: null,         // clip the view; seconds
    endTime: null,           // clip the view; seconds
    reqFilter: '',           // filter by request id substring
    showPageMetrics: true,   // horizontal page metric lines (LCP, TTI, etc.)
    showMarks: false,        // user timing marks
    showCpu: true,           // CPU utilization graph
    showBw: true,            // bandwidth graph
    showMainthread: true,    // main thread flame chart (wptagent, chrome-trace) or activity blocks
    showLongtasks: true,     // long task warnings
    showMissing: false,      // ellipses for missing requests
    showLabels: true,        // row text labels
    showChunks: true,        // per-chunk download blocks
    showJsTiming: true,      // JS execution highlights
    showWait: true,          // TTFB / wait blocks
    showLegend: true         // bottom legend
}
```

`renderTo` also accepts extra options not returned by `getDefaultOptions()`:

- `thumbMaxReqs` *(default 100)* — max requests drawn in `thumbnailView`. `0` disables truncation.
- `labelsCanvas` — separate canvas for URL labels when you want to split them out.
- `overlapLabels` — draw request rows full-width, ignoring the label gutter.
- `onHover(req)` / `onClick(req)` — interaction callbacks.

### Embedding

`renderTo(container, options)` is the supported embedding API; it replaces the earlier `div-embed.js` bootstrap. Pass a container and your options (including interaction callbacks) and drop the waterfall into any page.

## Hosting the viewer

A one-shot command materializes the viewer into a directory of your choice (typically your project's static web root):

```bash
npm install waterfall-tools @chrome-devtools/index
npx waterfall-tools install-viewer ./public/waterfall
```

This copies the viewer's static assets out of `node_modules/waterfall-tools/dist/browser/` into the target directory, then copies `node_modules/@chrome-devtools/index/` into `./public/waterfall/devtools-<version>/`, patches the DevTools bundle for browser hosting, and rewrites the viewer's `<meta name="waterfall-devtools-path">` to point at the versioned directory. Serve the target directory with any static file server.

Re-running the command updates the viewer in place and removes any stale `devtools-<prev-version>/` directories left over from earlier installs.

## Standalone viewer

The library ships with a pre-built standalone viewer — deployable as a static page, embeddable in an iframe, or usable as a full-page tool without writing your own UI.

Loading a HAR with multiple runs (e.g. WebPageTest First View + Repeat View) presents an interactive **Thumbnail Grid** showing each run's paint metrics, load times, and request counts before drilling into a specific trace.

The viewer integrates tab-switching to self-hosted copies of the **Perfetto Trace Viewer**, the **Chrome DevTools** frontend, and the legacy **Chrome NetLog Viewer** for deep inspection of DevTools metrics, timelines, and raw socket-level network events. The DevTools frontend is pulled in from the `@chrome-devtools/index` npm package at build time and copied under `dist/browser/devtools-<version>/` so it's served versioned alongside the viewer.

When inspecting an HTML response that has per-chunk timing and inflated byte counts (available from `tcpdump`, `netlog`, `chrome-trace`, `cdp`, and `wptagent`), the request inspector renders the **Response Body** as a hex-viewer-style table — one row per delivered wire chunk, with arrival timestamps and sizes in the left column and the syntax-highlighted HTML slice that arrived in that delivery on the right. This makes it easy to correlate "what arrived when" against the canvas waterfall.

A persistent **Waterfall History** in IndexedDB records every URL the viewer loads (from the landing page or via query parameters) along with test metadata.

### Query parameters

The viewer tracks its state via the browser History API, so the URL updates as you click around and is always shareable.

- `src=<url>` — remote file to fetch and load.
- `keylog=<url>` — TLS keylog to pair with `src` for raw packet captures.
- `page=<index>` — open a specific multi-page run (aliases `pageId`); skips the thumbnail grid.
- `tab=<name>` — jump to a tab: `summary`, `waterfall`, `trace` (Perfetto), `devtools`, `lighthouse`, `netlog`, or `RequestN` (e.g. `Request10`).
- `options=<csv>` — override defaults in `key:val` pairs (e.g. `options=showCpu:false,showBw:false`).

```
https://your-domain.com/viewer/?src=https://example.com/trace.json.gz&page=1_Cached&tab=Request10&options=showCpu:false,showWait:false
```

Without `src`, the viewer shows a URL entry bar and a drag-and-drop upload zone. Paste a WebPageTest result URL (`https://www.webpagetest.org/result/YYMMDD_.../`) and it automatically rewrites it to the HAR export endpoint.

### Iframe programmatic API

When embedding the viewer in an iframe, it exposes a global for pushing data without round-tripping through URL strings:

```html
<iframe id="waterfall-iframe" src="/dist/viewer/index.html"></iframe>
<script>
    const viewer = document.getElementById('waterfall-iframe').contentWindow.WaterfallViewer;

    // Push an ArrayBuffer, Blob, or File directly.
    viewer.loadData(arrayBuffer);

    // Re-render with tweaked options.
    viewer.updateOptions({ showCpu: true });
</script>
```

## CLI

```bash
npx waterfall-tools dump.cap.gz --keylog dump_keys.txt.gz > out.har
```

## Developer guide

### Setup

```bash
npm install
```

### Test

Tests are vitest suites that assert parsed outputs against golden Extended HAR fixtures.

```bash
npm test
```

### Lint

ESLint (flat config, `eslint.config.js`) is run automatically as the first step of `npm run build` — warnings fail the build (`--max-warnings 0`). Only first-party code under `src/`, `tests/`, `scripts/`, `bin/`, and `cloudflare-worker/` is linted; dependencies and vendored third-party bundles are excluded.

```bash
npm run lint       # report lint issues
npm run lint:fix   # auto-fix what is safe to auto-fix
```

### Build

```bash
# Builds ESM payloads under /dist/node/ and /dist/browser/waterfall-tools/.
# Output is hashed (waterfall-[hash].js, tcpdump-[hash].js, decompress-[hash].js)
# with a stable waterfall-tools.es.js stub that re-exports the hashed core —
# enabling immutable long-lived CDN caching.
# Each static artifact also gets a .br (Brotli level 11) sibling for zero-compute edge serving.
npm run build

# Local viewer preview with Hot Module Replacement against the live source.
npm run dev:viewer
```

### Demos

A drag-and-drop demo harness in `src/demo/` exercises the core pipelines graphically. Drop two files in sequence (e.g. a `.pcap` plus a `.key_log`) to combine packet tracing with live TLS decryption.

```bash
npm run dev:demo     # dev server with HMR
npm run build:demo   # bundled demo output under bin/demo/
```

### Continuous integration

Every pull request to `main` triggers `.github/workflows/ci.yml`, which installs dependencies with `npm ci` and then runs `npm run lint` and `npm run build` on Node 22. Lint warnings and build failures block the PR.

## License

Apache 2.0 — full text in [LICENSE](LICENSE). The dependency tree is deliberately free of GPL-licensed code.
