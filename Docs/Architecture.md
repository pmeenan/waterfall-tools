# Waterfall Tools Architecture

## Overview
The Waterfall Tools library is a highly performant, modular, client-side Vanilla JavaScript library for generating, viewing, and analyzing network waterfalls and filmstrips. It takes inspiration from WebPageTest, with an emphasis on performance, zero-bloat, and extensibility.

## Core Principles
- **Intermediary Data Format**: Everything standardizes to an Extended HAR (HTTP Archive) format.
- **Pluggability**: Input processors, output generators, and embeddable viewers are isolated and selectable.
- **Client-Rendered**: Canvas-based rendering with Vanilla JS for optimal performance.
- **Environment Agnostic**: Supports both Browser and Node.js environments where applicable.

## High-Level Architecture

```mermaid
graph TD
    %% Inputs
    subgraph Inputs ["Input Processors (inputs/)"]
        HARv1[HAR format]
        ChromeTrace[Chrome Trace, CDP & Perfetto]
        WPT[WPT Format & Netlog]
        Custom[Custom JSON]
        Tcpdump[PCAP / PCAPNG Captures]
    end

    %% Orchestrator
    subgraph Core ["Core Orchestration (core/)"]
        Orchestrator[Input Orchestrator]
        HAR_Ext[(Extended HAR Data Intermediary)]
        Conductor[Main Library Conductor API]
    end

    %% Outputs & Viewers
    subgraph Processors ["Output Processors (outputs/)"]
        ImageGen[Image Generator]
        ThumbGen[Thumbnail Generator]
        JSONGen[Simplified JSON]
    end

    subgraph Renderer ["Rendering Engine (renderer/)"]
        Canvas[Canvas Engine]
        Interactions[Interaction Hooks <br/> Hover/Click/Zoom/Filter]
    end

    subgraph Embed ["Embeddable Viewers (embed/)"]
        DirectEmbed[renderTo API Embedding]
        Iframe[Iframe / Query Params]
        External[External Viewers <br/> Perfetto / DevTools / NetLog Viewer]
    end

    %% Connections
    HARv1 --> Orchestrator
    ChromeTrace --> Orchestrator
    WPT --> Orchestrator
    Custom --> Orchestrator
    
    Orchestrator --> HAR_Ext
    HAR_Ext --> Conductor
    
    Conductor --> ImageGen
    Conductor --> ThumbGen
    Conductor --> JSONGen
    
    Conductor --> Canvas
    Canvas --> Interactions
    
    Conductor --> DirectEmbed
    Conductor --> Iframe
    Conductor --> External
```

## Directory Structure

```text
/
├── bin/                # CLI entry points and binary wrappers
│   └── waterfall-tools.js # Main CLI executable pulling from Core
├── src/
│   ├── inputs/             # Self-contained modules for processing specific input formats
│   │   ├── cli/            # Standalone CLI tools testing & generating Extended HARs
│   │   ├── utilities/      # Internal parsing pipelines & decoupled bin protocol helpers
│   │   │   └── tcpdump/    # Deep packet inspection modular helpers (TLS, QUIC, TCP/UDP)
│   │   ├── har.js          # Standard HAR passthrough
│   │   ├── chrome-trace.js
│   │   ├── perfetto.js     # Perfetto protobuf binary parser
│   │   ├── wpt-json.js     # WebPageTest pipeline
│   │   ├── netlog.js       # Raw Chrome proxy tracker
│   │   ├── cdp.js          # Chrome DevTools network protocols
│   │   ├── tcpdump.js      # Processes PCAP/PCAPNG packets
│   │   └── orchestrator.js # API for converting chosen input to intermediary HAR
│   ├── outputs/            # Modules for generating various output formats
│   │   ├── image.js        # Waterfall image generation
│   │   ├── thumbnail.js    # Thumbnail generation
│   │   └── simple-json.js  # Simplified request data
│   ├── renderer/           # Waterfall canvas rendering logic
│   │   ├── canvas.js       # Core rendering loop
│   │   ├── layout.js       # Positioning and geometry calculations
│   │   └── interaction.js  # Hooks for hover, click, zoom, filtering
│   ├── embed/              # Website embedding support
│   │   ├── iframe-embed.js # Iframe query param handling
│   │   └── external/       # Wrappers for Perfetto, Chrome DevTools
│   ├── core/               # Shared logic, schemas, and main library conductor
│   │   ├── har-types.js    # Extended HAR conventions
│   │   └── conductor.js    # Main API interface
│   ├── viewer/             # Self-contained, full-featured standalone frontend UI
│   │   ├── index.html      # Main presentation container
│   │   ├── viewer.js       # App controller handling loading, layout routing, drag-and-drop, history API, interactions (tooltips), and generating dynamic Request Detail Tabs
│   │   ├── history.js      # IndexedDB wrapper securely managing waterfall history states tracking user URLs
│   │   └── public/         # Self-hosted static dependencies (sw.js, favicons) copied natively via Vite
│   │       └── netlog-viewer/ # Standalone compiled Chrome NetLog viewer HTML bundle
│   ├── platforms/          # Environment-specific implementations (e.g., File I/O vs Fetch)
│   │   ├── browser/
│   │   └── node/
│   └── filmstrip/          # (Future) Filmstrip and screenshot processing
├── vite.config.js          # Library build configuration
├── vite.demo.config.js     # Standalone viewer frontend configuration
├── Sample/                 # Sample files and reference implementations
│   ├── Data/               # Sample input files grouped by format (e.g., HAR/source1)
│   └── Implementations/    # Sample python parsing implementations by format
```

## CLI Modes and Testing
Each input format processor acts as an independent module that includes a **stand-alone CLI mode**. The CLI takes a single input file format and generates an output file in the intermediary Extended HAR format. This standalone mode doubles as the primary testing vector: automated tests parse known sample data and assert that the CLI-generated outputs strictly match known-good Extended HAR outputs (after an initial baseline is captured).

## Intermediary Data Format (Extended HAR)
The library uses the standard HAR 1.2 format as a base. Any application-specific data extracted from non-HAR formats (such as Chrome Traces or WPT data) will be stored in fields prefixed with an underscore (`_`), per the HAR specification allowance for custom fields. 

Example:
```json
{
  "log": {
    "version": "1.2",
    "creator": {
      "name": "waterfall-tools",
      "version": "x.x.x"
    },
    "entries": [
      {
        "startedDateTime": "2023-10-01T12:00:00.000Z",
        "time": 50,
        "request": { ... },
        "response": { ... },
        "_initiator": "script.js",
        "_renderBlocking": true,
        "_connectionReused": false
      }
    ]
  }
}
```

### Tcpdump Bandwidth & Chunk Timing
When processing PCAP captures, the tcpdump processor estimates the maximum download bandwidth by running a 100ms sliding window over all server-to-client packets in the capture. This value (in Kbps) is stored as `_bwDown` on the page object, enabling the canvas renderer to calculate per-chunk download durations for granular waterfall visualization. Individual response data chunks from HTTP/1, HTTP/2 DATA frames, and HTTP/3 DATA frames are mapped to `_chunks` arrays with absolute millisecond timestamps and byte counts. HTTP/2 stream priority is parsed from HEADERS frames (when the PRIORITY flag is set) and standalone PRIORITY frames, mapping the weight to Chrome-compatible priority strings (Highest/High/Medium/Low/Lowest). HTTP/3 priority is extracted from the `priority` request header using RFC 9218 Extensible Priorities urgency values. Request overhead (`_bytesOut`) is estimated from serialized request headers, and uncompressed response sizes (`_objectSizeUncompressed`) are tracked when content-encoding decompression produces a different size than the wire bytes.

### Multi-File Archives & OPFS Integration
When processing complex multi-asset packages natively encapsulating several files uniquely (e.g., `wptagent` ZIP archives chaining JSON traces, netlogs, and screenshots), parsers MUST mitigate memory bloat forcefully. The architecture seamlessly utilizes the Web **Origin Private File System (OPFS)** natively paired dynamically with the `Web Locks API`. This bridges native unzipped file assets precisely through `data._opfsStorage` and `data._zipFiles` boundaries inherently, granting the main library unified mechanisms (`getPageResource()`) to securely map isolated Blob URLs natively to images or raw string chunks efficiently dynamically on-demand, without permanently unpacking and exhausting available RAM natively.

#### Nested Response Bodies (`_bodies.zip`)
WPTAgent ZIP archives contain nested `[run]_bodies.zip` (and `[run]_Cached_bodies.zip`) archives holding individual response body files. Each request in `devtools_requests.json` references its body via the `body_file` field (e.g., `001-<id>-body.txt`). During processing, the wptagent parser extracts these nested zips into temporary storage, reads each referenced body file, base64-encodes the content, and stores it on the HAR entry's `response.content.text` with `encoding: 'base64'`. The temporary storage is destroyed immediately after extraction to minimize memory usage.

#### Chunked HTML Body Inspection
For HTML responses with both `_chunks` (with timestamps) and a base64-encoded body, the standalone viewer's request inspector renders the response body as a per-chunk hex-viewer-style table instead of one monolithic block. The body is decoded once into a `Uint8Array` and sliced by `inflated` byte counts (or wire `bytes` when `inflated` is absent), with `TextDecoder` stream-mode handling UTF-8 sequences split across chunk boundaries. Each row shows the chunk's waterfall-relative arrival time, request-relative offset, and inflated/wire byte counts in a narrow left column, alongside the syntax-highlighted HTML slice that arrived in that delivery in a wide right column. This makes it trivial to correlate "what arrived when" against the canvas waterfall timeline.

## Progress Reporting & Event Loop Yielding
All input parsers support an optional `options.onProgress(phase, percent)` callback for real-time processing feedback. The `loadBuffer()` method automatically injects `totalBytes` into options so parsers can scale progress proportionally to bytes consumed. The tcpdump parser reports the most granular progress across 5 distinct phases (reading packets, TLS decryption, protocol decoding, UDP decoding, waterfall building) and inserts `setTimeout(0)` yield points between phases and periodically within long synchronous loops to prevent browser "script too long" dialogs. Other stream-based parsers yield naturally at each `await reader.read()` chunk boundary. The standalone viewer displays a CSS-animated progress bar during processing, driven by this callback.

## Rendering Engine
The renderer uses the native HTML5 `<canvas>` API rather than the DOM (e.g., creating hundreds of `<div>` tags) to ensure that rendering thousands of requests doesn't cause browser layout trashing. The canvas engine is completely autonomous, instantiated against a parent container div where it utilizes native `ResizeObserver` instances to self-recalculate structural geometric bounds responsive to viewport changes perfectly. Interaction is handled by maintaining a spatial index of drawn elements and mapping mouse coordinates to data entries. Application logic overrides can be supplied via robust hook events system injected into the render core. It natively supports specialized rendering modes (e.g., **Connection View** for multiplexing visualization, or **Thumbnail View** for dense overviews) configurable via standard render option primitives. Since HAR files can natively contain multiple pages (such as First View and Repeat View runs from WebPageTest), the rendering engine assumes callers actively filter the global pool of request entries to specifically match only the single active page ID before passing them to the rendering loop natively.

## Embeddable Components
The architecture natively accommodates integration directly securely into web apps. The `WaterfallTools.renderTo(containerElement, options)` API handles deep integrations organically, superseding any separate `div-embed.js` boilerplate. IFrame configurations rely on structured message passing or parsed query parameters for headless integration with data resources. 

## Build and Bundling
The project uses Vite (backed by Rolldown/Rollup) to package the library into modular ES Modules (ESM). The configuration must strictly support tree-shaking, preserving cross-platform aliasing (`scripts/build.js`) replacing runtime environment branches (like canvas wrappers) with statically resolvable targets securely.

### Strict Artifact Generation
To maximize load performance and caching efficiency across integrations natively, the library explicitly avoids excessive fragmentation (dozens of micro-chunks) by lifting decoupled streaming parsers (`@streamparser/json`) to static imports globally. As a baseline, the bundler generates exactly three primary payload artifacts:
1. `waterfall-tools.es.js` - The core application logic, HTML5 canvas renderer, and standard JSON streaming processors.
2. `tcpdump-[hash].js` - The dynamically loaded chunk isolated specifically for TCPDump, PCAP, SSL decryption, QUIC, and standard deep-packet inspection tooling natively.
3. `decompress-[hash].js` - The dynamically loaded chunk exclusively isolating WebAssembly decompression fallbacks like `brotli-dec-wasm` protecting core payloads accurately.

## Responsive UI Boundaries & Pinch Geometry
Mobile configurations securely trigger layout breakpoints bypassing explicit device definitions using structural flex bindings inherently ensuring 3-across grids neatly wrap appropriately across scaling devices gracefully. Touch listeners (`touchstart`, `touchmove`) attached explicitly within `WaterfallCanvas` decode multi-point geometry calculating `startTime` and `endTime` transformations intrinsically seamlessly scaling absolute grids organically horizontally while skipping standard `dpr` scaling recalculations explicitly.
