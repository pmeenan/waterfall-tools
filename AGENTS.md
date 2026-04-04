# Waterfall Tools: AI Agent Guidance & Context

Welcome. You are working on the **Waterfall Tools** library, a powerful, robust, and client-side solution for displaying detailed network request waterfalls akin to WebPageTest.

## 🎯 Directives for AI Agents

When working on this codebase, you must adhere to the following strict architectural principles and workflow:

1. **Mandatory Project Context & Workflow:**
   - **Initial Step:** At the beginning of any task, you must read `Docs/Architecture.md` to understand the project architecture and `Docs/Plan.md` for the project implementation plan.
   - **Closing Step:** At the end of each conversation, you must update `README.md`, `Docs/Plan.md`, and `Docs/Architecture.md` with any respective changes. Furthermore, update `AGENTS.md` with any information that would benefit future agents either as a result of the current conversation or as discovered while working on the current conversation (it is the long-term memory for the project).

2. **Zero Bloat & Peak Performance:**
   - **No Heavy Frameworks:** This library must remain exceptionally fast, lightweight, and distributable. Prefer **Vanilla JavaScript** when it makes sense. Feel free to use external libraries as necessary if they significantly improve the architecture or functionality. Do not introduce React, Vue, Svelte, or Angular under any circumstances within the core lib space.
   - **DOM Performance:** Avoid generating thousands of DOM elements (e.g., specific divs for every network request). Network waterfalls frequently exceed 1,000+ requests globally. Rendering must leverage raw native `<canvas>` operations optimizing for seamless 60fps scrolling latency buffers.

3. **The Intermediary Format (Extended HAR):**
   - Feature rendering cannot tightly couple against raw unique inputs (eg. directly rendering an external WebPageTest object without conversions).
   - Every input format **MUST** map entirely to the standard **Extended HAR format** payload pipeline immediately prior to engaging renderer states or internal processor hooks.
   - The generated HAR **MUST** include a `creator` object within `log` identifying `waterfall-tools` as the generating tool.
   - When broadening properties beyond the standard HAR `1.2` specification schema logic, always strictly prefix keys with an underscore `_` (e.g., `_priority`, `_renderBlockingConstraints`, `_initiator`). 

4. **Pluggable & Declarative Architecture:**
   - Component classes defining input modules (`src/inputs/`), output modules (`src/outputs/`), embed viewers (`src/embed/`), and drawing renderers (`src/renderer/`) are decoupled entities deliberately separated inherently.
   - The primary orchestrator object operates uniquely by transporting verified Extended HAR data uniformly across specific decoupled systems cleanly without implicit mutation states.
   - Modules must export structurally permitting granular bundler operations like Webpack, Vite or Rollup safely tree-shaking specific elements entirely out of arbitrary compilation phases natively. (A consumer integrating browser-only HAR generation shouldn't package unused Node libraries).

5. **Environment Nuances & File Modularity:**
   - Code residing fundamentally inside `src/core/` and the root interface level of `src/inputs/` strictly stays conditionally isomorphic (e.g., `src/inputs/tcpdump.js`). Ensure runtime viability targeting concurrently Node.js and Browser JS endpoints safely.
   - Separate CLI Wrappers exclusively into `src/inputs/cli/` (e.g., `src/inputs/cli/tcpdump.js`) so that generic bundlers evaluating APIs won't accidentally traverse `process.stdout` hooks indiscriminately.
   - Segment format-specific logic gracefully. Standalone decoders natively reside in `src/inputs/utilities/[format]/` avoiding monopolizing top-level directories natively.
   - Interaction demanding Web APIs like (`fetch()`, `HTMLCanvasElement`, browser `window`) isolate explicitly into segmented folders encompassing respectively `src/platforms/browser/`, `src/renderer/`, or `src/embed/`. Node native tools (`fs` integration pipelines) deploy cleanly only into `src/platforms/node/`.

6. **Future-Proofing Hardware Considerations:**
   - Ensure the structure accommodates adopting powerful native WASM instances gracefully isolated internally exclusively for computationally heavy future requirements, for example massive Chrome Trace unzipping / reduction iterations or binary frame unpacking processes. Image compilation explicitly respects standardized Canvas APIs first natively across operations naturally.

7. **CLI Modes & Testing Validation:**
   - Each input format MUST feature a stand-alone CLI mode wrapper capable of ingesting an input file and exporting the normalized intermediary Extended HAR serialization. This wrapper should be built as an individual standalone CLI script (e.g., `src/inputs/cli-[format].js`).
   - Write comprehensive tests asserting that parsing sample logic matches established "known-good" HAR output targets (generated during initial implementations) perfectly.
   - For alternative formats originating from the same tests as HAR files (e.g. Netlogs), explicitly include validation pipelines (like Node.js `scripts/`) ensuring the parsed requests map reliably back to their matching baseline WebPageTest HAR representations. Leverage file prefix naming conventions for robust automated matching (e.g. `www.google.com-netlog.json.gz` against `www.google.com.har.gz`).

8. **Sample Assets Organization:**
   - Store all sample files for respective data formats cleanly partitioned within the `Sample/Data/` root (e.g., `Sample/Data/HAR/sourceA`, `Sample/Data/ChromeTrace/site1`).
   - If writing or utilizing reference parsing implementations (like exploratory Python scripts decoding specific unmapped formats), place them explicitly in `Sample/Implementations/` mapped by format folders inherently.

9. **Target Environments (Evergreen Browsers & Node):**
   - The minimal baseline for Javascript execution and Web API usage are the **latest stable versions of Chrome, Firefox, Safari, and Node.js**. 
   - You may freely use the newest ES syntax and native platform capabilities (e.g. modern `<canvas>` APIs, generic `fetch()`, latest `Intl` formats) without needing to transpile or polyfill for backward legacy compatibility.

10. **Fault Tolerance & Streaming Execution:**
   - The input processors should be strictly tolerant of malformed or truncated input files, degrading gracefully rather than hard-crashing.
   - Processing massively large payloads MUST leverage stream-based architectures (prefer true streaming parsers like `stream-json` specifically) rather than lazily loading massive uncompressed strings entirely into V8 heap memory (`JSON.parse()`).
   - **Crucially:** Input processors dealing with extremely bloated inputs (e.g. Chrome Traces or WebPageTest JSON files) SHOULD utilize primitive Transform streams before the JSON Assembler to aggressively discard massive extraneous fields (like `generated-html` or `almanac`) natively at the token level safely preventing V8 memory exhaustion.
   - Input files can frequently be supplied in gzip format organically. Input wrappers must automatically detect compressions by sniffing file magic byte headers (e.g., `1f 8b` for gzip) over blindly trusting `.gz` extensions, unzipping pipes natively on-the-fly (`zlib.createGunzip()`).

11. **Implementation Notes & Current Conventions:**
    - **Extended HAR Standard:** The complete schema definition of custom properties (e.g., `_load_ms`, `_ttfb_ms`, `_bytesIn`) derived from WebPageTest is documented definitively in `Docs/Extended-HAR-Schema.md`.
    - **Type Definitions (JSDoc):** Though the project explicitly isolates to Vanilla JavaScript, zero-compilation type safety modeling is rigorously structured via JSDoc annotations. Always reference `src/core/har-types.js` when mutating payload definitions to preserve mapping without invoking TypeScript compilers.
    - **Vite & ESM Framework:** The library defines natively as an ES Module (`"type": "module"`). Utilizing standard Vite in library mode builds ESM and UMD packages to `/dist`. Any executing context should properly process ES `import`/`export` keywords seamlessly.

12. **Testing & Golden Fixtures:**
    - Comparing massive object payloads (such as thousands of network requests parsed from Traces) with `assert.deepStrictEqual` can hang `node:test` execution indefinitely if there are `undefined` property mismatches. Always sanitize results via `JSON.parse(JSON.stringify(result))` before asserting against disk-saved JSON fixtures.
    - Always scrub dynamically generated keys (e.g., fallback `startedDateTime` values using `Date.now()`) from both the parsed object and the reference golden fixture prior to running deep comparisons.

13. **Streaming Nuances (Web Streams & Async Iterators):**
    - The core library natively utilizes **Web Streams API** (`ReadableStream`, `DecompressionStream`, `TextDecoderStream`) across all standard inputs preventing any requirement for Node native pipelines.
    - JSON processing seamlessly leverages `@streamparser/json` matching native iterable pipelines natively natively cleanly dropping legacy `stream-json` bottlenecks.
    - **Piped Stream Destruction**: Native web streams do not natively auto-close connected file handles in Node bridging layers organically; `finally` blocks must manually invoke `.destroy()` on generated `fs.ReadStream` instances immediately upon `getReader().read()` completions.

14. **Parallel Fallback Architecture & O(n) Mitigations:**
    - Fallback strategies natively parsing alternative execution paths (e.g. Chrome trace `devtools.timeline` elements substituting explicitly to form arrays matching missing `netlog` configurations) must continuously buffer `id` constraints carefully.
    - When bridging buffered entities across multiple distinct event paths against massive baseline arrays (15,000+ entries linearly), always aggressively index payloads utilizing explicit `Map` structures preventing catastrophic O(N^2) memory loop stalls internally.

15. **Isomorphic Binary Streams (PCAP/PCAPNG):**
    - Raw binary ingestion pipelines (e.g. `PcapParser`) MUST operate strictly on native `Uint8Array` slicing and `DataView` abstractions rather than Node.js specific `Buffer` classes. This guarantees zero-copy native browser parsing against massive payloads without triggering Node polyfill imports.
    - **Note on PCAPNG Requirements:** The initial parser framework supports sniffing PCAPNG magics and extracting `Enhanced Packet Blocks` (EPB). However, timestamp precision explicitly assumes microsecond intervals. Proper timestamp mapping requires tracking `Interface Description Block` (IDB) options, which should be finalized when actual `.pcapng` capture files are included for complete test coverage.
    - The raw `PcapParser` natively handles decoding `Ethernet`, `IPv4`, `IPv6`, `TCP`, and `UDP` directly alongside the container unwrapping to prevent deep loop regressions across independent processor domains.

16. **Offline QUIC & HTTP/3 Decoding:**
    - Because `waterfall-tools` reassembles QUIC streams offline from `.cap.gz` captures, the `decodeQuic` logic fully unwraps `1-RTT` AEAD payloads and gracefully tracks all `RFC-9000` frame types without breaking on non-stream frames natively.
    - QUIC Header Protection natively utilizes `AES-ECB` directly; however, WebCrypto organically rejects native ECB mapping organically globally. Consequently, `quic-crypto.js` maps a 16-byte raw `AES-CBC` initialization exclusively employing a fully zeroed IV perfectly mirroring identical single-block ECB states matching WebCrypto constraints smoothly.
    - When unpacking HTTP/3 fragments mapping to proper Request streams natively, the `QpackDecoder` strictly maintains a stateful tracking mechanism parsing the relative bounds of encoder dynamic table instructions linearly. This guarantees the highest reconstruction fidelity without employing massive client memory leaks safely.

17. **TCPDump HAR Assembler:**
    - The `tcpdump.js` processor natively flattens the multidimensional array of reconstructed flows (TCP connections with HTTP/1 & 2 objects, UDP blocks with HTTP/3, explicit DoH unlinked pipelines) mapping chronologically aligned structures tightly against resolved DNS tables. It guarantees standard Extended HAR payload generations directly matching downstream CLI endpoints.

18. **Orchestrator & API Conventions:**
    - The library handles automatic format detection via `src/inputs/orchestrator.js` utilizing file peeking and magic-byte/token sniffing natively so the caller does not need to define input formats strictly.
    - All format processors accept `input` generic signatures (`processXNode(input, options)`) uniformly supporting either file paths or raw `Readable` streams gracefully.
    - The main `Conductor` artifact represents the central class and exposes `processFile` and `processStream` methods bridging inputs systematically.
    - The root unified CLI resides at `bin/waterfall-tools.js` wrapping the `Conductor` logic securely for global terminal access across formats natively while automatically discovering matching `keylog` inputs implicitly.
    - **API Documentation**: Whenever you modify APIs (such as `waterfall-tools.js` methods or rendering parameters like `renderTo()` default options), you MUST comprehensively document these modifications structurally inside the `README.md` and explicitly note them within this `AGENTS.md` context log ensuring future AI Agents seamlessly identify the exposed signatures.

19. **Output Processors (Headless):**
    - The `simple-json` output processor (`src/outputs/simple-json.js`) provides a strictly 1D array mapping of `ExtendedHAR` request entries. It collapses deep `request` and `response` object trees into simple top-level properties (e.g. `url`, `method`, `status`, `ttfb_ms`) natively suitable for generic JavaScript iterators.

20. **Zero Polyfill Browser Architecture:**
    - The core input parsers are strictly entirely isomorphic mapping exclusively across the exact Web APIs shipped comprehensively natively natively (`window.crypto.subtle`, `DecompressionStream`, `Uint8Array`, `TextDecoderStream`).
    - Standard Node modules (`fs`, `zlib`, `crypto`) are securely dynamically imported matching isolated backend targets effectively avoiding breaking native browser rollup configurations intrinsically inherently.
    - The frontend integration natively converts standard Browser `File` objects securely matching `Blob.stream()` cleanly immediately skipping any heavy Vite polyfill requirements previously needed natively.

21. **Renderer Timestamp Mapping:**
    - The Extended HAR standard explicitly leverages absolute ISO strings for `startedDateTime`. However, internal renderer states (like `canvas.js` drawing timelines) must strictly normalize all entry timings to **relative millisecond offsets** calculated off the earliest absolute `startedDateTime` in the entire collection. Failing to normalize to a zero-point relative index will cause `requestAnimationFrame` canvas loops calculating timestamp grids to iterate trillions of times, instantly crashing the browser tab.
    - **Crucially:** When synthesizing Chrome Traces utilizing `devtools.timeline` elements as a fallback (due to missing `netlog` configurations), standard `.ts` representations frequently encode absolute `CLOCK_MONOTONIC` system uptimes (e.g. `89,356,270,953` ms). Parsers MUST correctly extract the absolute minimum baseline `requestTime` globally and subtract it strictly from all bounds gracefully ensuring relative zero-indexing.

22. **Canvas Rendering Rules (WPT Parity):**
    - High DPI displays require `window.devicePixelRatio` multiplication against `canvas.width`/`height` and a scaled context (`ctx.scale(dpr, dpr)`) internally so logic coordinates remain absolute CSS logical measurements natively.
    - Vertical timeline grids draw **underneath** request bar blocks, but **over** the alternating row-background highlighted bands natively.
    - Global Page Metric lines (like Start Render, LCP) explicitly draw **over** the time grid but **behind** the network request block layouts inherently.
    - `TTFB` represents the underlying gradient base of a request layer when detailed download properties are present, mapping fully to `downloadEnd` time lengths, whereas specific downloaded `Chunks` overlay the TTFB base opaquely natively reflecting byte progression streams carefully.
    - Connection initiation phases (`Wait`, `DNS`, `Connect`, `SSL`) strictly leverage solid WPT standardized colors rather than scaling the `baseColor` derived from content types seamlessly preventing confusion across the timeline natively.
    - Row backgrounds explicitly highlight redirects (HTTP 300-399, excluding 304) with an opaque warning yellow and highlight errors (HTTP >= 400, or 0) with an opaque error red natively matching WPT visibility parameters (painted at 100% opacity prior to rendering request blocks).
    - **Legend Rendering**: The visual legend aligns with WPT. Connection phases (Wait, DNS, Connect, SSL) draw as solid thick uniform bars. MIME content types (HTML, JS, Image, etc.) draw as split 20px wide bars displaying their lightened TTFB color (`scaleRgb(color, 0.65)`) on the left half and their primary download color on the right.
23. **Code Documentation & Analysis (Train-of-Thought):**
    - Ensure all source code logic, especially dense mathematical and coordinate-bound mapping segments (like Canvas rendering or input byte-parsing), is extremely well commented.
    - Write robust "train-of-thought" inline documentation that explicitly explains *why* a calculation operates in a specific boundary order, rather than just what the syntax does.
    - Extensive comments serve as a critical analytical breadcrumb trail for future AI Agents to efficiently follow complex execution scopes without executing brute-force reverse engineering.
    - The build pipeline natively utilizes Vite/Rollup tools out-of-the-box which aggressively minify and automatically strip source comments dynamically before final generation; thus, heavily prioritizing inline clarity yields zero bloat impacts in production outputs.

24. **HTML5 Canvas vs PHP GD Geometry (Bounds & Inclusivity):**
    - The legacy WebPageTest PHP renderer uses GD functions (like `imagefilledrectangle`) explicitly treating geometric coordinates as **inclusive**. For example, drawing a rectangle from `x1 = 10` to `x2 = 10` logically targets the pixel itself, but legacy loop incrementing often forces `x2 = x1 + 1` executing a `2px` footprint intrinsically. 
    - When translating logic to HTML5 `<canvas>`, `fillRect(x, y, w, h)` utilizes raw deltas (`w = x2 - x1`). A delta of identically snapped coordinates mapped to `x2 = x1 + 1` mathematically computes to `1px`, wiping the span from visibility over top-level layers. 
    - Always strictly append `+ 1` to HTML5 `fillRect` width logic translated from PHP boundaries (`width = (x2 - x1) + 1`) to ensure critical 2px-minimum visibility for identical-timestamp events natively (e.g., `_domContentLoadedEventStart` identical to `_domContentLoadedEventEnd`).

25. **Renderer Edge Cases & UI Behaviors:**
    - **Label Layering:** Metric labels mapped geometrically against the timeline grid must forcefully paint an opaque background layout exactly matching the respective underlying row stripe (`#ffffff` or `#f0f0f0`). This strictly sits *behind* the font text to prevent vertical time grids bleeding through typography natively.
    - **Cross-Domain Contexts:** Request URL labels evaluate their `_documentURL` iteratively against the base document URL (inherited from `rawEntries[0]`). Mismatched origins natively format text into blue (`#0000ff`) indicating secure iframe execution environments mimicking WPT.
    - **Render Blocking Indicators:** When `_renderBlocking` validates to exactly `blocking`, legacy WPT injects `render-block-icon.png`. Zero-asset web rendering securely recreates this natively using standard DOM canvas shapes (deploying a perfectly aligned 14px orange `#ff9900` circle holding a 1.5px white stroked geometric `X`).

26. **Diagnostic Logging (Debug Flags):**
    - All API entry points (`Conductor`, CLI wrappers, Viewers) and inner input/output processors MUST implement and respect an `options.debug` boolean flag uniformly to preserve zero-bloat high-performance pathways in production default states.
    - When `options.debug === true`, parsers MUST selectively output key operational telemetry via `console.log` and `console.error` (e.g. streaming chunks processed, routing completions, protocol deviations) establishing a robust breadcrumb trace specifically assisting local debugging iterations elegantly across node and browser contexts securely. All tests executing natively implicitly set `{ debug: true }`.

27. **Canvas Responsiveness:**
    - The viewer implementations (e.g. `src/demo/canvas/viewer.js`) must preserve the core `ExtendedHAR` state globally upon parsing completion. This ensures debounced `window.addEventListener('resize')` closures can recalculate Layout bounds (`Layout.calculateRows`) securely, pushing non-destructive structural updates cleanly into existing Canvas Renderers continuously matching active viewport dimensions natively.

28. **Multi-Page HAR Rendering:**
    - Standard HAR files, particularly those generated from WebPageTest JSON processors, natively encapsulate multiple independent testing runs (e.g. `First View`, `Repeat View`) as strictly discrete `pages` within the same `log` payload.
    - Renderers MUST rigorously filter global `log.entries` arrays precisely matching the desired active `pageObj.id` string before executing visual layout mappings. Failing to filter cross-page entries natively collapses disjointed execution timelines (separated by hundreds of seconds) onto single overlapping scales instantly destroying local time grid bounds.

29. **Format Sniffing Resiliency:**
    - When automatically detecting input formats (like WebPageTest JSON), avoid relying on keys that could appear arbitrarily deep within the JSON payload. For instance, WebPageTest traces might not immediately expose `"runs"` or `"median"` in the initial buffer window; sniffing logic in `orchestrator.js` must safely evaluate a broader union of indicator keys (e.g., `"testRuns"`, `"average"`) to successfully identify valid format structures without reading massive files entirely into memory up front.
    - **DecompressionStream Bounds:** When sniffing gzipped files, the `DecompressionStream` bounded buffer chunks must be sufficiently large. For formats like Netlog, dictionaries (like `"logEventTypes"`) frequently do not appear until around byte 4500. Sniffing bounds must reliably process at least the first 64KB (`65536` bytes) to prevent false-negative `"unknown"` identification results.
    - **Dual-File Handling:** Frontend viewer implementations (like `src/demo/canvas/viewer.js`) organically support dual-file drops (e.g., a `.pcap` simultaneously with a `.key_log`). Processing must explicitly run the standard `identifyFormatFromBuffer` mechanism across all dropped files internally mapping correctly rather than relying exclusively on simple string/name-matching fallbacks. Keylogs uniquely identify via `CLIENT_RANDOM` or `CLIENT_TRAFFIC_SECRET_0` strings within buffers.

30. **Mutable Array Reference Safety:**
    - Parsing routines mapping nested arrays across independently iterated models (e.g., copying HTTP/2 stream `chunks` down to specific Chrome `netlog` request arrays) MUST explicitly clone object arrays natively (`JSON.parse(JSON.stringify(stream.chunks))`). If shared by-reference arrays traverse globally scoped mutation steps (like `postProcessEvents` decrementing `chunk.ts` by relative trace `start_time`), overlapping array references will execute subtraction logic destructively across multiple identical paths corrupting the temporal payload irreversibly natively.

31. **HTTP/3 & QPACK Nuances**: The `QpackDecoder` natively supports decoding `Indexed Field Line`, `Literal Field Line`, etc., strictly abiding by RFC 9204 prefix bounds rather than HPACK constants. For offline 0-RTT/1-RTT QUIC HTTP/3 streams extracted from `.pcap` flows, Request Headers are frequently missing if the first client packets fail decryption or are contained in undecrypted 0-RTT ranges. In these cases, we map the Server's HTTP Response streams to instantiate the `ExtendedHAR` entry anyway, bypassing standard dual-header-presence validation. QPACK string values utilizing Huffman encodings (H bit = 1) evaluate natively using a zero-dependency dynamically constructed Huffman tree based on RFC 7541, falling back to primitive UTF-8 seamlessly upon failure preventing parser stalls.

32. **QUIC vs STUN Multiplexing**: Port 443 frequently carries non-QUIC UDP traffic (specifically WebRTC STUN/TURN). Standard QUIC Short Headers explicitly enforce the `Fixed Bit (0x40)` constraint. Parsers handling raw UDP payloads (`quic-decoder.js`) strictly drop Datagrams when `(firstByte & 0x40) === 0`, gracefully ignoring STUN bursts seamlessly preventing noisy MAC parsing failures across fallback loops. Early Connection ID mappings (`scidLen`/`dcidLen`) accurately mutate dynamically tracking directionality uniformly reflecting transient server identities explicitly inherited from active Initial phases.

33. **TLS Interleaving & HPACK Decoding**: When reconstructing TCP/TLS streams (e.g., `TlsDecoder`), client and server `contiguousChunks` MUST be interleaved chronologically before execution. Feeding all client chunks before server chunks guarantees `ServerHello` random values are missed stalling symmetric key derivations instantly. HTTP/2 HPACK header decompression is handled by a custom zero-dependency `HpackDecoder` class (`src/inputs/utilities/tcpdump/hpack-decoder.js`) implementing RFC 7541 entirely with browser-native APIs (`Uint8Array`, `DataView`). It shares the same Huffman tree infrastructure as `QpackDecoder`. The decoder exposes a simple synchronous `decode(uint8Array)` method returning `[{name, value}]` arrays, maintaining stateful dynamic table context across calls per connection direction.

34. **Solid Download Chunks Fallback**: When drawing the waterfalls and max bandwidth is not available (`maxBw === 0`), individual `chunks` cannot accurately map their duration on the timeline. Rather than drawing hundreds of 1px slivers exactly at their timestamp, the render natively falls back to drawing a solid download block spanning from the end of TTFB (the timestamp of the first chunk) to the end of the request.

35. **Hygiene & Temporary Assets**: During active development workflows or parsing investigations, AI agents will frequently create throw-away diagnostic scripts (like `test-dns.js` or `parse-tracer.js`), generated sample outputs (like `out.json`), or massive `.har` test outputs scattered in the root directory. **Agents MUST meticulously track and clean up** (delete) all standalone testing hooks, debugging `.log` files, and generic CLI scratch files prior to concluding their development sequence globally to prevent polluting the repository tree.

36. **Document-Wide Drag Interactions:** When implementing drag-and-drop file targets across the entire `document.body` while child elements (like `<canvas>`) exist, native `dragleave` events will fire continuously as hover states cross child boundaries. To prevent UI overlays from rapidly flickering open and closed, utilize a `dragCounter` variable incremented on `dragenter` and decremented on `dragleave`. Only hide the overlay when `dragCounter === 0`.

37. **Chrome Trace Timing Offsets**: Native Chrome Netlogs log `time` natively in system MILLISECONDS, whereas Chrome DevTools Traces log `trace_event.ts` strictly in MICROSECONDS (`89,445,124,782`). Because `normalizeNetlogToHAR` assumes internally standardized arrays already map entirely to MILLISECONDS, mapping DevTools Traces correctly requires aggressive mathematical scaling. Explicitly divide ALL microsecond bounds by `1000.0` inside `chrome-trace.js` instantly before creating the HAR generation natively preventing 80+ billion metric bounds cascading into `Date()` instances triggering `RangeError: Invalid time value` failures across renderers natively. Ensure missing Timeline `requestTime` objects strictly bypass synthesis gracefully preventing `NaN` timeline corruptions natively.

38. **Chrome Trace Netlog Pointer Aliasing**: Chrome trace dumps do not guarantee unique string `id` attributes for `netlog` network requests. Instead they utilize `id2.local` which natively represents a C++ memory pointer. Because C++ reallocates identical pointer addresses strictly asynchronously, a single massive trace frequently maps dozens of disjoint `URL_REQUEST_START_JOB` lifecycles sequentially sharing the identical `"0x1a5"` identifier. Parsers exclusively utilizing `id2` (or even native Python Netlog implementations assuming uniqueness) WILL irreversibly corrupt timestamp properties by infinitely merging consecutive lifecycle metrics over each other. 
    - **Fix Implementation**: Parsers MUST intercept `URL_REQUEST_START_JOB` (or `REQUEST_ALIVE`) `ph="b"` boundaries natively and actively multiplex incoming pointer addresses (assigning each "begin" boundary to a brand new sequentially unique `log` identifier internally). Subsequent chunks tracking the shared `id2.local` correctly execute against the active multiplexed mapping.

39. **Monotonic to Real Epoch Conversion**: Chrome traces natively use `CLOCK_MONOTONIC` (system uptime) for all timestamps (`ts`). The `normalizeNetlogToHAR` function requires a real UNIX epoch to generate valid `startedDateTime` ISO strings. Parsers MUST extract real wall-clock time from the first HTTP `date:` response header encountered during streaming to compute a monotonic-to-epoch offset. Crucially, when applying `req.start` offsets to the baseline to create individual `Date` objects, never pass seconds directly to `new Date(seconds)` as it expects milliseconds natively causing dramatic 1000x scale disparities resulting in rendering engine Infinite Loops/OOMs. Always compute: `new Date(baseEpochMs + req.startMs)`.

40. **Test Framework (Vitest):**
    - All tests MUST use **vitest** (`import { describe, it, expect } from 'vitest'`), NOT `node:test` or `node:assert`. The project uses vitest as its test runner (`npm test` runs `vitest`).
    - Use `describe`/`it` for test structure and `expect()` for assertions (e.g., `expect(x).toBe(y)`, `expect(x).toEqual(y)`, `expect(x).toBeTruthy()`, `expect(fn).rejects.toThrow()`).
    - Test files follow the `*.test.js` naming convention under `tests/inputs/` and `tests/outputs/`.

41. **CDP (Chrome DevTools Protocol) Timing Nuances:**
    - CDP Network events (`Network.requestWillBeSent`, `Network.responseReceived`) log natively in system seconds (`timestamp`), but the underlying DevTools layout operates strictly in milliseconds. Parsers MUST calculate the relative differences (e.g. `timestamp - first_timestamp`) and explicitly multiply by `1000.0`.
    - Furthermore, `response.timing` objects (like `dnsStart`, `connectStart`) natively log relative millisecond offsets against `requestTime`. Parsers MUST aggressively compute and map these relative bounds to the absolute Request `startTime` explicitly; otherwise, critical visual phases (DNS, TCP, TLS) will completely fail to appear in standard Waterfall exports.
    - Because CDP intercepts do not natively guarantee a `responseReceived` phase for aborted or manually blocked requests, parsers must actively scrub unbounded requests (where `endTime` remains undefined) and explicitly fault them out (`errorCode = 12999`) preventing infinite loading state ghost bars natively.

42. **Universal Absolute Timing & Parallel Waterfall Phases:**
    - Standard HAR implementations fundamentally calculate execution bounds by purely chaining timing durations sequentially (`time_start` + `blocked` + `dns` + `connect` + `send` + `wait`). This natively destroys parallel network metrics (such as a predictive DNS lookup occurring _during_ a request queue block) forcing extreme layout drift pushing HTTP streams massively out of synchronization.
    - To reflect actual hardware parallelism natively mapped by tools like WebPageTest, the `ExtendedHAR` normalizers (`har-converter.js`, `wpt-json.js`, `cdp.js`, `netlog.js`) inherently encapsulate discrete WPT geometric constraints directly via aliased mappings (`_dns_start`, `_load_start`, `_ttfb_end`, `_download_start`). 
    - The rendering engine (`layout.js`) rigorously attempts to bypass conventional arithmetic `timings` arrays exclusively utilizing universal absolute epochs (`hasAbsoluteTimings`) against these `_*` constraints natively, guaranteeing mathematically identical visualizations aligning fully to legacy reference frames across all modern ingestion pipelines safely.

43. **Data Parsing Robustness (WPT JSON Polymorphism):**
    - WebPageTest JSON utilization structures (like CPU or Bandwidth) can manifest differently depending on the export version. Sometimes they bundle generically as arrays (`[ {dataDict}, maxVal, avgVal ]`) and sometimes as strictly keyed dictionaries (`{ data: {dataDict}, max: maxVal, count: avgVal }`).
    - Data parsing normalizers MUST strictly accommodate both polymorphic structures universally and rigorously map them into consistent array outputs (`[time, scaledPct]`) specifically scaling internal values securely using their embedded maximum limits before submitting to the downstream renderer.
    - Preserving mathematical limits naturally inside normalizer arrays (i.e., `arr.max = maxVal`) enables layout frontends to dynamically cast highly accurate formatted labels (scaling dynamic suffixes logically like Mbps natively via `mbps.toFixed(1)`) safely referencing unmodified bounds intrinsically.

44. **Canvas Engine Execution Guards (Path Poisoning):**
    - Natively rendering lines within the `CanvasRenderingContext2D` utilizes strict mathematical paths (`moveTo`, `lineTo`, `stroke`). 
    - If **any** dynamically mapped coordinate sequence evaluates to `NaN` or `Infinity` structurally within a `.beginPath()` bounding sequence, the entire resulting path is irreversibly poisoned natively completely stripping it from drawing to the screen. Always strictly guard layout geometry inherently using `isFinite(x) && isFinite(y)` logic within iterative arrays completely dodging mathematical anomalies without throwing explicit hard-errors blocking background processes entirely.

45. **Independent UI Control Interdependencies:**
    - Component layouts occasionally bundle multiple features conceptually spanning physical canvas layers together identically (for example, combining CPU Line algorithms inside Bandwidth Chart Frames). Ensure boolean conditional toggles strictly evaluate distinctly internally preventing hierarchical dependencies from unexpectedly swallowing orthogonal configuration branches unconditionally.

46. **Context Mutation Independence:**
    - **Canvas fillStyle Context**: Always explicitly set `ctx.fillStyle` or `ctx.strokeStyle` using the computed styling *immediately before* invoking HTML5 canvas geometry methods like `fillRect` or `stroke`. Neglecting to set the style assigns the previously lingering color state on the context (often the default `#000000` or `#ffffff`), effectively rendering data layers completely invisible or rendering incorrectly without raising console errors.

47. **Stair-Stepped Utilization Graphs:** When drawing utilization graphs (like CPU and Bandwidth) in the waterfall canvas renderer, the values represent the utilization over the *previous* time window, rather than an instantaneous measurement. Therefore, these graphs must be drawn using a stair-stepped line generation logic (drawing to the new value at the previous time stamp, and then drawing a horizontal line to the new time stamp) to accurately reflect the original reporting window natively preventing skewed diagonal interpolations.

48. **QUIC / HTTP/3 Netlog Multiplexing**: Unlike HTTP/2 connections which cleanly map against `processStreamJobEvent` dependencies, Chrome Netlogs log multiplexed QUIC bindings natively inside `processUrlRequestEvent` (acting directly on the `URL_REQUEST` source). Thus, identifying QUIC multiplexing requires explicitly trapping `HTTP_STREAM_REQUEST_BOUND_TO_QUIC_SESSION` and mapping the incoming `source_dependency` directly to `quic_session`. Relying purely on the `quicSession.stream` matching logic fails natively since Chromium leaves the corresponding `stream_id` formally undefined inside `URL_REQUEST` dictionaries.
