# Waterfall Tools

Waterfall Tools is a robust, performant library for parsing, analyzing, and visualizing complex network waterfalls dynamically in the browser or via Node.js. It standardizes vastly differing network trace formats (like PCAP, Netlog, Chrome Trace, CDP, WebPageTest) into a unified Extended HAR (HTTP Archive) payload, then leverages native `<canvas>` APIs to naturally draw fast, accurate, WebPageTest-style interactive waterfall charts without causing sluggish DOM layout recalculations.

## Features

- **Format Agnostic**: Easily parses `HAR`, `Netlog`, `Chrome Trace`, `Perfetto Protobuf`, `CDP`, `WebPageTest JSON`, and raw `TCPDUMP` captures (with automatic TLS/QUIC payload decryption, bandwidth estimation, per-chunk download timing, and HTTP/2 & HTTP/3 priority extraction).
- **Core Orchestrator (`WaterfallTools`)**: Unified API that identifies format types automatically, parsing them uniformly into strict structurally-sound relational payloads.
- **Isomorphic Architecture**: The core generative pipelines naturally run natively inside Node.js and directly alongside Vite projects inside modern Browsers without requiring any polyfills — all binary and cryptographic operations use browser-native Web APIs (`Uint8Array`, `DataView`, `WebCrypto`, `DecompressionStream`).
- **Zero DOM-Bloat Canvas Renderer**: Scales cleanly to visually render 50 or 50,000 requests smoothly, mitigating severe `O(N)` UI thrashing typical in trace viewer projects.
- **Offline Capable (PWA)**: The standalone viewer natively implements a Service Worker caching strategy allowing seamless usage without an internet connection.
- **Response Body Inspection**: When response bodies are available (e.g., from Netlog decoded bytes, WPTAgent nested `_bodies.zip` archives, tcpdump packet captures, or standard HAR `response.content.text`), the viewer displays them with syntax highlighting for text formats (HTML, CSS, JS, JSON, XML) and renders images inline. Binary content shows size information. For tcpdump imports, response bodies compressed with `gzip`, `deflate`, `br` (Brotli), or `zstd` content-encoding are automatically decompressed using native `DecompressionStream` where available, with pure-JS fallbacks (`brotli`, `fzstd`) for environments that lack lack native support.
- **CORS Fetch Proxy (optional)**: A single-file [Cloudflare Worker](cloudflare-worker/) is provided as a CORS-friendly `fetch()` fallback for URL-based imports when the remote origin doesn't send CORS headers. It only proxies content matching a known waterfall-tools input format, forwards the caller's real IP upstream (non-anonymizing), blocks obvious SSRF targets, and applies a per-IP failure rate-limit. Zero bindings required — paste `cloudflare-worker/worker.js` into the Cloudflare dashboard.

For a deeper dive into the system's design architecture, logic conventions, and folder hierarchy, see [Docs/Architecture.md](Docs/Architecture.md).

## Installation (coming soon)

```bash
npm install waterfall-tools
```

## API Usage

Ensure your build system supports generic ESModules (`"type": "module"` natively out-of-the-box). The single interface for the library is the `WaterfallTools` class.

> [!NOTE]
> **Optional Asset Bundles:** The built dist binaries purposefully compartmentalize `tcpdump-[hash].js` (tcpdump processing) and `decompress-[hash].js` (tcpdump Brotli decompression) from the main core library. 
> To serve the simplest single-file integration, you can safely host only the core `waterfall-[hash].js` and its proxy stub `waterfall-tools.es.js`! The library will gracefully degrade if it cannot dynamically reach the separated supplement chunks over the network.

### Processing a Local File (Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools';

const wt = new WaterfallTools();

// Automatically identifies the file format natively (No options required!)
await wt.loadFile('./trace.cap.gz');
const waterfallHar = wt.getHar();

console.log(`Successfully generated HAR with ${waterfallHar.log.entries.length} requests`);
```

### Processing a Stream (Browser or Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools';
import { Readable } from 'stream'; // Handled globally via NodeJS, polyfilled natively targeting browsers

const wt = new WaterfallTools();

// Note: You must explicitly specify `options.format` when piping a streaming target.
const fileStream = new Readable({
    read() {
        this.push(bufferData);
        this.push(null);
    }
});

await wt.loadStream(fileStream, { 
    format: 'tcpdump', 
    isGz: true, 
    keyLogInput: keyLogStream // You can concurrently explicitly provide TLS keylog hooks!
});
const waterfallHar = wt.getHar();
```

### Processing a Non-Streaming Buffer (Browser or Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools';

// When you already have the file totally loaded in memory (Buffer, ArrayBuffer, Uint8Array):
const bufferData = await uploadedFile.arrayBuffer();

// The core engine will automatically sniff the array bytes identifying formats naturally!
const wt = new WaterfallTools();
await wt.loadBuffer(bufferData);
```

### Progress Tracking (Browser)

When processing large files in the browser, you can pass an `onProgress` callback to receive real-time updates. This keeps the UI responsive and enables progress bar rendering.

```javascript
const wt = new WaterfallTools();
await wt.loadBuffer(bufferData, {
    onProgress: (phase, percent) => {
        console.log(`${phase} — ${percent}%`);
        // Update your progress bar UI here
    }
});
```

The `phase` string describes the current processing stage (e.g., `"Reading packets..."`, `"Decrypting TLS..."`, `"Building waterfall..."`). The `percent` value ranges from 0 to 100. The tcpdump parser reports the most granular progress across 5 distinct phases; other parsers report stream-reading progress proportional to bytes consumed.

### Loading from an External URL (Browser or Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools';

// The library automatically fetches, extracts, sniffs, and processes remote trace payloads.
const wt = new WaterfallTools();
await wt.loadUrl('https://example.com/trace.json.gz');
```

### Retrieving Extracted Assets (Screenshots, Traces)

The library provides an isomorphic abstraction to fetch unboxed files or embedded Base64 strings generically across Node.js (`{buffer}`) and Web Browsers (`{url}`). This securely prevents memory bloat by pulling assets specifically mapped off ZIP `_opfsStorage` architectures efficiently when needed rather than ballooning JSON state natively!

```javascript
// Automatically fetches `1_screen.jpg` extracted bounds mapping off `page_1_0_1` 
// Can fetch 'screenshot', 'trace', 'netlog', 'lighthouse', etc.
const resource = await wt.getPageResource('page_1_0_1', 'screenshot');
if (resource) {
    if (resource.url) console.log('Blob URL dynamically injected mapping to Image tags:', resource.url);
    if (resource.buffer) console.log('Node.js UInt8Array extracted cleanly out of filesystem');
}
```

### Visualizing using the View Engine (Browser Context)

```javascript
import { WaterfallTools } from 'waterfall-tools';

const wt = new WaterfallTools();
await wt.loadUrl('https://example.com/trace.json.gz');

// The engine targets a parent container div and natively generates & manages its own internal `<canvas>`
const containerElement = document.getElementById('waterfall-container');

// You can retrieve the default configuration options logically:
const defaultOptions = WaterfallTools.getDefaultOptions();
console.log(defaultOptions);
/*
{
    pageId: null,             // Specific page to render (defaults to the first page)
    connectionView: false,    // Render the connection view rather than the waterfall
    thumbnailView: false,     // Render a minimal thumbnail view
    minWidth: 0,              // Minimum canvas width in pixels
    startTime: null,          // Float, start time in seconds to clip the view
    endTime: null,            // Float, end time in seconds to clip the view
    reqFilter: '',            // String to filter specific request IDs
    showPageMetrics: true,    // Render horizontal page metric lines
    showMarks: false,         // Render user timing marks
    showCpu: false,           // Render the CPU utilization graph
    showBw: false,            // Render the Bandwidth graph
    showMainthread: true,     // Render main thread activity blocks
    showLongtasks: true,      // Render long task warnings
    showMissing: false,       // Render ellipsis for missing requests
    showLabels: true,         // Render text labels on rows
    showChunks: true,         // Show individual download chunks
    showJsTiming: true,       // Highlight JS execution timings
    showWait: true,           // Render the wait time (TTFB) blocks
    showLegend: true,         // Render the bottom legend
    thumbMaxReqs: 100,        // Maximum requests to draw when thumbnailView=true (0 disables truncation)
    labelsCanvas: null,       // Optional distinct canvas mapping URL text overlays logically
    overlapLabels: false      // Renders request rows full-width logically ignoring standard label column sizes natively
}
*/

// Instantiate the renderer completely mapped and scaled automagically natively:
await wt.renderTo(containerElement, Object.assign({}, defaultOptions, { minWidth: 800 }));
```

### Web Embedding (Superseding `div-embed.js`)

The `WaterfallTools.renderTo(containerElement, options)` API is the standard and fully supported mechanism for embedding Waterfall Tools directly into any generic webpage. 

By passing your target DOM container and your preferred options (which can include callbacks for interactivity), you can easily drop a robust, high-performance canvas-based waterfall directly into your own applications. This unified approach formally supersedes the need for any separate or legacy `div-embed.js` bootstrapping utilities.

## Standalone Viewer UI

The library includes a pre-built, production-ready standalone viewer application. This is ideal for distributing as a static HTML page, embedding cleanly via an `iframe`, or using as a dedicated full-page waterfall tool without building your own UI.
If you load a HAR file containing multiple testing iterations (such as WebPageTest's First and Repeat views), the viewer will automatically present an interactive mathematical **Thumbnail Grid View** cleanly surfacing the respective Paint metrics, load times, and request counts before drilling into specific traces.

Additionally, the Viewer embraces integrated tab-switching capabilities routing dynamically to self-hosted embedded instances of the **Perfetto Trace Viewer** and the legacy **Chrome NetLog Viewer**, allowing comprehensive exploration of native Chrome DevTools metrics, timeline processing, and raw socket-level network events interactively!

When inspecting an HTML response that has per-chunk timing data and inflated byte counts (available from `tcpdump`, `netlog`, `chrome-trace`, `cdp`, and `wptagent` inputs), the request inspector automatically renders the **Response Body** as a hex-viewer-style table — one row per delivered wire chunk, with the chunk's arrival timestamps and sizes in a narrow left column and the syntax-highlighted slice of HTML that arrived in that delivery in the wide right column. This makes it easy to visually correlate "what arrived when" against the canvas waterfall.

### Using the Viewer

You can dynamically configure the viewer using URL query parameters that map seamlessly to the internal state matrix. The viewer actively tracks states natively using the browser's **History API**, dynamically updating the URL bar as you click around, enabling perfectly reproducible and shareable configurations.

**Viewer Query Parameters:**
- `src=<url>` : Points to the remote file to download and load automatically.
- `keylog=<url>` : Points to the remote TLS keylog file to use in conjunction with `src` when loading raw packet captures (e.g., tcpdump/pcap files).
- `page=<index>` : Opens deeply into a specific multi-page iteration (aliasing `pageId`). Skips the thumbnail grid entirely if matching successfully.
- `tab=<name>` : Skips directly to a specified tab (`summary`, `waterfall`, `trace`, `lighthouse`, `netlog`). Can cleanly auto-generate dynamic detail tabs referencing `RequestX` (e.g., `&tab=Request10` jumps right to the respective Request Details).
- `options=<csv>` : Pass targeted viewer config properties strictly overriding defaults in a `key:val` format minimizing URL length (e.g., `options=showCpu:false,showBw:false`).

```
https://your-domain.com/viewer/?src=https://example.com/trace.json.gz&page=1_Cached&tab=Request10&options=showCpu:false,showWait:false
```

Alternatively, if no `src` parameter is provided, the viewer automatically presents a clean URL entry bar and a drag-and-drop file upload interface. If you paste a WebPageTest result URL (e.g., `https://www.webpagetest.org/result/YYMMDD_.../`), the viewer will automatically transform it to fetch the standard HAR payload.

### Iframe Programmatic API

When embedding the viewer within an iframe, the app globally exposes an API to inject buffers natively without routing payloads via URL strings:

```html
<iframe id="waterfall-iframe" src="/dist/viewer/index.html"></iframe>
<script>
    // Example: Passing an intercepted ArrayBuffer directly into the viewer iframe
    document.getElementById('waterfall-iframe').contentWindow.WaterfallViewer.loadData(arrayBuffer);
    
    // Example: Re-rendering with explicit bounds
    document.getElementById('waterfall-iframe').contentWindow.WaterfallViewer.updateOptions({ showCpu: true });
</script>
```

## CLI Interface

The package ships securely with a fully operational terminal interface automating the processing payloads down into their unified HAR outputs directly from your shell configurations.

```bash
npx waterfall-tools dump.cap.gz --keylog dump_keys.txt.gz > compiled-output.har
```

## Developer Contribution Guide

If you are cloning this repository to build, modify, or run native integrations:

### Initial Setup
```bash
npm install
```

### Validate against Fixtures
Testing strictly relies on validating standard stream processors against native `.json` reference golden fixtures securely tracking structural mutations.
```bash
# Leverages Vitest sequentially locally
npm run test
```

### Compile Library Assets & Standalone Viewer UI
```bash
# Formats and bundles the embeddable standalone app natively into `/dist/browser/`.
# Builds explicit ESModules using Rollup into `/dist/node/` and `/dist/browser/waterfall-tools/`.
# All output assets natively utilize hashes (e.g. `waterfall-[hash].js`, `tcpdump-[hash].js`) mapping statically.
# A standard proxy stub `waterfall-tools.es.js` routes elegantly mapped against hashed payloads dynamically maximizing immutable CDN cached responses.
# Finally, all static distribution elements recursively compress into highly optimized identical `.br` (Brotli Level 11) fallback targets directly accessible via `nginx` and standard distribution engines.
npm run build

# Start local server to preview viewer wrapper natively with Hot Module Replacement (HMR) attached directly to the local source files
npm run dev:viewer
```

### Utilizing Local Demos (Canvas Viewers)
An interactive Drag-and-Drop frontend showcase wrapper directly maps `src/demo` pipelines naturally testing your active core adjustments graphically.
- **Tip**: You can drop two files consecutively (like a `.pcap` and `.key_log`) to seamlessly combine packet tracing with embedded TLS decryption visually on-the-fly.
```bash
# Launch Dev Server locally to quickly validate interface updates
npm run dev:demo

# Hard compile frontend standalone viewers fully targeting `bin/demo/` distributions
npm run build:demo
```

## License

This project is licensed under the Apache 2.0 License. It is completely free to use without restrictions. The repository and its dependency tree are explicitly designed to be unencumbered and do not include any GPL (General Public License) code or dependencies of any flavor.

---
*Note: This repository is actively iterated with strict multi-page layout rendering architectures mapping native WPT JSON runs seamlessly offline without framework bloat.*
