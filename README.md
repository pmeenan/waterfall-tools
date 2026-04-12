# Waterfall Tools

Waterfall Tools is a robust, performant library for parsing, analyzing, and visualizing complex network waterfalls dynamically in the browser or via Node.js. It standardizes vastly differing network trace formats (like PCAP, Netlog, Chrome Trace, CDP, WebPageTest) into a unified Extended HAR (HTTP Archive) payload, then leverages native `<canvas>` APIs to naturally draw fast, accurate, WebPageTest-style interactive waterfall charts without causing sluggish DOM layout recalculations.

## Features

- **Format Agnostic**: Easily parses `HAR`, `Netlog`, `Chrome Trace`, `Perfetto Protobuf`, `CDP`, `WebPageTest JSON`, and raw `TCPDUMP` captures (with automatic TLS/QUIC payload decryption support).
- **Core Orchestrator (`WaterfallTools`)**: Unified API that identifies format types automatically, parsing them uniformly into strict structurally-sound relational payloads.
- **Isomorphic Architecture**: The core generative pipelines naturally run natively inside Node.js and directly alongside Vite projects inside modern Browsers without requiring any polyfills — all binary and cryptographic operations use browser-native Web APIs (`Uint8Array`, `DataView`, `WebCrypto`, `DecompressionStream`).
- **Zero DOM-Bloat Canvas Renderer**: Scales cleanly to visually render 50 or 50,000 requests smoothly, mitigating severe `O(N)` UI thrashing typical in trace viewer projects.
- **Response Body Inspection**: When response bodies are available (e.g., from Netlog decoded bytes, WPTAgent nested `_bodies.zip` archives, tcpdump packet captures, or standard HAR `response.content.text`), the viewer displays them with syntax highlighting for text formats (HTML, CSS, JS, JSON, XML) and renders images inline. Binary content shows size information. For tcpdump imports, response bodies compressed with `gzip`, `deflate`, `br` (Brotli), or `zstd` content-encoding are automatically decompressed using native `DecompressionStream` where available, with pure-JS fallbacks (`brotli`, `fzstd`) for environments that lack native support.

For a deeper dive into the system's design architecture, logic conventions, and folder hierarchy, see [Docs/Architecture.md](Docs/Architecture.md).

## Installation (coming soon)

```bash
npm install waterfall-tools
```

## API Usage

Ensure your build system supports generic ESModules (`"type": "module"` natively out-of-the-box). The single interface for the library is the `WaterfallTools` class.

### Processing a Local File (Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools/core/waterfall-tools.js';

const wt = new WaterfallTools();

// Automatically identifies the file format natively (No options required!)
await wt.loadFile('./trace.cap.gz');
const waterfallHar = wt.getHar();

console.log(`Successfully generated HAR with ${waterfallHar.log.entries.length} requests`);
```

### Processing a Stream (Browser or Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools/core/waterfall-tools.js';
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
import { WaterfallTools } from 'waterfall-tools/core/waterfall-tools.js';

// When you already have the file totally loaded in memory (Buffer, ArrayBuffer, Uint8Array):
const bufferData = await uploadedFile.arrayBuffer();

// The core engine will automatically sniff the array bytes identifying formats naturally!
const wt = new WaterfallTools();
await wt.loadBuffer(bufferData);
```

### Loading from an External URL (Browser or Node.js)

```javascript
import { WaterfallTools } from 'waterfall-tools/core/waterfall-tools.js';

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
import { WaterfallTools } from 'waterfall-tools/core/waterfall-tools.js';

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
    thumbMaxReqs: 100         // Maximum requests to draw when thumbnailView=true (0 disables truncation)
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

### Using the Viewer

You can dynamically configure the viewer using URL query parameters that identically map to the configuration options available in `WaterfallTools.getDefaultOptions()`. The viewer seamlessly tracks states natively using the browser's **History API**, enabling smooth "Back" and "Forward" navigation across nested waterfalls and thumbnail overviews.

```
https://your-domain.com/viewer/?src=https://example.com/trace.json.gz&showCpu=false&viewType=connection
```

Alternatively, if no `src` parameter is provided, the viewer automatically presents a clean drag-and-drop file upload interface.

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

### Compile Library Assets
```bash
# Builds standardized Universal Module Definitions (UMD) & pure ESModules natively into `/dist`
npm run build
```

### Compile Standalone Viewer UI
```bash
# Formats and bundles the embeddable standalone app natively into `/dist/viewer/`
npm run build:viewer

# Start local server to preview viewer wrapper natively
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

---
*Note: This repository is actively iterated with strict multi-page layout rendering architectures mapping native WPT JSON runs seamlessly offline without framework bloat.*
