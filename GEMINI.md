# Waterfall Tools: AI Agent Guidance & Context

Welcome. You are working on the **Waterfall Tools** library, a powerful, robust, and client-side solution for displaying detailed network request waterfalls akin to WebPageTest.

## 🎯 Directives for AI Agents

When working on this codebase, you must adhere to the following strict architectural principles:

1. **Zero Bloat & Peak Performance:**
   - **No Heavy Frameworks:** This library must remain exceptionally fast, lightweight, and distributable. Prefer **Vanilla JavaScript** when it makes sense. Feel free to use external libraries as necessary if they significantly improve the architecture or functionality. Do not introduce React, Vue, Svelte, or Angular under any circumstances within the core lib space.
   - **DOM Performance:** Avoid generating thousands of DOM elements (e.g., specific divs for every network request). Network waterfalls frequently exceed 1,000+ requests globally. Rendering must leverage raw native `<canvas>` operations optimizing for seamless 60fps scrolling latency buffers.

2. **The Intermediary Format (Extended HAR):**
   - Feature rendering cannot tightly couple against raw unique inputs (eg. directly rendering an external WebPageTest object without conversions).
   - Every input format **MUST** map entirely to the standard **Extended HAR format** payload pipeline immediately prior to engaging renderer states or internal processor hooks.
   - The generated HAR **MUST** include a `creator` object within `log` identifying `waterfall-tools` as the generating tool.
   - When broadening properties beyond the standard HAR `1.2` specification schema logic, always strictly prefix keys with an underscore `_` (e.g., `_priority`, `_renderBlockingConstraints`, `_initiator`). 

3. **Pluggable & Declarative Architecture:**
   - Component classes defining input modules (`src/inputs/`), output modules (`src/outputs/`), embed viewers (`src/embed/`), and drawing renderers (`src/renderer/`) are decoupled entities deliberately separated inherently.
   - The primary orchestrator object operates uniquely by transporting verified Extended HAR data uniformly across specific decoupled systems cleanly without implicit mutation states.
   - Modules must export structurally permitting granular bundler operations like Webpack, Vite or Rollup safely tree-shaking specific elements entirely out of arbitrary compilation phases natively. (A consumer integrating browser-only HAR generation shouldn't package unused Node libraries).

4. **Environment Nuances & File Modularity:**
   - Code residing fundamentally inside `src/core/` and the root interface level of `src/inputs/` strictly stays conditionally isomorphic (e.g., `src/inputs/tcpdump.js`). Ensure runtime viability targeting concurrently Node.js and Browser JS endpoints safely.
   - Separate CLI Wrappers exclusively into `src/inputs/cli/` (e.g., `src/inputs/cli/tcpdump.js`) so that generic bundlers evaluating APIs won't accidentally traverse `process.stdout` hooks indiscriminately.
   - Segment format-specific logic gracefully. Standalone decoders natively reside in `src/inputs/utilities/[format]/` avoiding monopolizing top-level directories natively.
   - Interaction demanding Web APIs like (`fetch()`, `HTMLCanvasElement`, browser `window`) isolate explicitly into segmented folders encompassing respectively `src/platforms/browser/`, `src/renderer/`, or `src/embed/`. Node native tools (`fs` integration pipelines) deploy cleanly only into `src/platforms/node/`.

5. **Future-Proofing Hardware Considerations:**
   - Ensure the structure accommodates adopting powerful native WASM instances gracefully isolated internally exclusively for computationally heavy future requirements, for example massive Chrome Trace unzipping / reduction iterations or binary frame unpacking processes. Image compilation explicitly respects standardized Canvas APIs first natively across operations naturally.

6. **CLI Modes & Testing Validation:**
   - Each input format MUST feature a stand-alone CLI mode wrapper capable of ingesting an input file and exporting the normalized intermediary Extended HAR serialization. This wrapper should be built as an individual standalone CLI script (e.g., `src/inputs/cli-[format].js`).
   - Write comprehensive tests asserting that parsing sample logic matches established "known-good" HAR output targets (generated during initial implementations) perfectly.
   - For alternative formats originating from the same tests as HAR files (e.g. Netlogs), explicitly include validation pipelines (like Node.js `scripts/`) ensuring the parsed requests map reliably back to their matching baseline WebPageTest HAR representations. Leverage file prefix naming conventions for robust automated matching (e.g. `www.google.com-netlog.json.gz` against `www.google.com.har.gz`).

7. **Sample Assets Organization:**
   - Store all sample files for respective data formats cleanly partitioned within the `Sample/Data/` root (e.g., `Sample/Data/HAR/sourceA`, `Sample/Data/ChromeTrace/site1`).
   - If writing or utilizing reference parsing implementations (like exploratory Python scripts decoding specific unmapped formats), place them explicitly in `Sample/Implementations/` mapped by format folders inherently.

8. **Target Environments (Evergreen Browsers & Node):**
   - The minimal baseline for Javascript execution and Web API usage are the **latest stable versions of Chrome, Firefox, Safari, and Node.js**. 
   - You may freely use the newest ES syntax and native platform capabilities (e.g. modern `<canvas>` APIs, generic `fetch()`, latest `Intl` formats) without needing to transpile or polyfill for backward legacy compatibility.

9. **Fault Tolerance & Streaming Execution:**
   - The input processors should be strictly tolerant of malformed or truncated input files, degrading gracefully rather than hard-crashing.
   - Processing massively large payloads MUST leverage stream-based architectures (prefer true streaming parsers like `stream-json` specifically) rather than lazily loading massive uncompressed strings entirely into V8 heap memory (`JSON.parse()`).
   - **Crucially:** Input processors dealing with extremely bloated inputs (e.g. Chrome Traces or WebPageTest JSON files) SHOULD utilize primitive Transform streams before the JSON Assembler to aggressively discard massive extraneous fields (like `generated-html` or `almanac`) natively at the token level safely preventing V8 memory exhaustion.
   - Input files can frequently be supplied in gzip format organically. Input wrappers must automatically detect compressions by sniffing file magic byte headers (e.g., `1f 8b` for gzip) over blindly trusting `.gz` extensions, unzipping pipes natively on-the-fly (`zlib.createGunzip()`).

10. **Implementation Notes & Current Conventions:**
    - **Extended HAR Standard:** The complete schema definition of custom properties (e.g., `_load_ms`, `_ttfb_ms`, `_bytesIn`) derived from WebPageTest is documented definitively in `Docs/Extended-HAR-Schema.md`.
    - **Type Definitions (JSDoc):** Though the project explicitly isolates to Vanilla JavaScript, zero-compilation type safety modeling is rigorously structured via JSDoc annotations. Always reference `src/core/har-types.js` when mutating payload definitions to preserve mapping without invoking TypeScript compilers.
    - **Vite & ESM Framework:** The library defines natively as an ES Module (`"type": "module"`). Utilizing standard Vite in library mode builds ESM and UMD packages to `/dist`. Any executing context should properly process ES `import`/`export` keywords seamlessly.

11. **Testing & Golden Fixtures:**
    - Comparing massive object payloads (such as thousands of network requests parsed from Traces) with `assert.deepStrictEqual` can hang `node:test` execution indefinitely if there are `undefined` property mismatches. Always sanitize results via `JSON.parse(JSON.stringify(result))` before asserting against disk-saved JSON fixtures.
    - Always scrub dynamically generated keys (e.g., fallback `startedDateTime` values using `Date.now()`) from both the parsed object and the reference golden fixture prior to running deep comparisons.

12. **Streaming Nuances (`stream-json` & `stream-chain`):**
    - When parsing JSON objects or massive arrays incrementally via `stream-array`, avoid explicitly piping streams loosely (`readStream.pipe(streamJson()).pipe(asStream())`) as Node's multiplexing can occasionally drop streaming tokens or hang the event loop on tests.
    - Always strictly bundle stream-json steps linearly using `stream-chain` architectures: `const pipeline = chain([readStream, parser(), streamArray()]);` to safely preserve token pipelines synchronously.
    - **Piped Stream Destruction:** When "sniffing" raw headers identically using read streams piped into Transform interfaces (like `zlib.createGunzip()`), aggressively `.destroy()` the foundational underlying raw `fs.createReadStream` explicit target. Calling `.destroy()` or `.pause()` on the terminal `zlib` stream uniquely leaves the file read stream permanently hanging blocking event loop completions!

13. **Parallel Fallback Architecture & O(n) Mitigations:**
    - Fallback strategies natively parsing alternative execution paths (e.g. Chrome trace `devtools.timeline` elements substituting explicitly to form arrays matching missing `netlog` configurations) must continuously buffer `id` constraints carefully.
    - When bridging buffered entities across multiple distinct event paths against massive baseline arrays (15,000+ entries linearly), always aggressively index payloads utilizing explicit `Map` structures preventing catastrophic O(N^2) memory loop stalls internally.

14. **Isomorphic Binary Streams (PCAP/PCAPNG):**
    - Raw binary ingestion pipelines (e.g. `PcapParser`) MUST operate strictly on native `Uint8Array` slicing and `DataView` abstractions rather than Node.js specific `Buffer` classes. This guarantees zero-copy native browser parsing against massive payloads without triggering Node polyfill imports.
    - **Note on PCAPNG Requirements:** The initial parser framework supports sniffing PCAPNG magics and extracting `Enhanced Packet Blocks` (EPB). However, timestamp precision explicitly assumes microsecond intervals. Proper timestamp mapping requires tracking `Interface Description Block` (IDB) options, which should be finalized when actual `.pcapng` capture files are included for complete test coverage.
    - The raw `PcapParser` natively handles decoding `Ethernet`, `IPv4`, `IPv6`, `TCP`, and `UDP` directly alongside the container unwrapping to prevent deep loop regressions across independent processor domains.

15. **Continuous Documentation Maintenance:**
    - Whenever a task in the `Docs/Plan.md` is checked as completed, you MUST update `GEMINI.md`, `Docs/Architecture.md`, and `Docs/Plan.md` with any relevant architectural changes, technical decisions, or new information discovered during the execution of that task. This ensures all future autonomous agent steps maintain the latest context without relying on past chat history.

16. **Offline QUIC & HTTP/3 Decoding:**
    - Because `waterfall-tools` reassembles QUIC streams offline from `.cap.gz` captures, the `decodeQuic` logic fully unwraps `1-RTT` AEAD payloads and gracefully tracks all `RFC-9000` frame types without breaking on non-stream frames natively.
    - When unpacking HTTP/3 fragments mapping to proper Request streams natively, the `QpackDecoder` strictly maintains a stateful tracking mechanism parsing the relative bounds of encoder dynamic table instructions linearly. This guarantees the highest reconstruction fidelity without employing massive client memory leaks safely.

17. **TCPDump HAR Assembler:**
    - The `tcpdump.js` processor natively flattens the multidimensional array of reconstructed flows (TCP connections with HTTP/1 & 2 objects, UDP blocks with HTTP/3, explicit DoH unlinked pipelines) mapping chronologically aligned structures tightly against resolved DNS tables. It guarantees standard Extended HAR payload generations directly matching downstream CLI endpoints.
