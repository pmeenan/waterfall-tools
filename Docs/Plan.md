# Waterfall Tools Implementation Plan

This document breaks down the development of the Waterfall Tools library into independent, bite-sized tasks suitable for an AI agent to tackle sequentially. We are adopting a **Bottom-Up, CLI-First** approach. By building standalone input processors first, we establish robust, known-good data fixtures that downstream UI and rendering systems can rely on immediately.

## Phase 1: Core Setup & Schema Definition
**Goal:** Establish the project structure and strictly define the Extended HAR schema.
- [x] Initialize the Node project configuration with Rollup/Vite.
- [x] Create the directory structure outlined in `Docs/Architecture.md`.
- [x] Establish `Sample/Data/` with format sub-folders and `Sample/Implementations/` for reference Python scripts.
- [x] Define the Extended HAR schema core typing in `src/core/har-types.js`. **Crucially**, base this extended schema on the specific HAR file format structure utilized by WebPageTest, referencing the examples located in `Sample/Data/HARs/WebPageTest/`.

## Phase 2: Standalone Input Processors (CLI First)
**Goal:** Build independent, highly-testable parsers for each input type that generate the standardized HAR payload.
- [x] Implement `src/inputs/har.js` to accept raw standard HAR files and normalize them into the strictly structured Extended HAR format.
- [x] Build a stand-alone CLI mode wrapper for the HAR parser that takes an input file and generates the intermediary HAR file output.
- [x] Create automated tests validating the HAR parser against known-good sample outputs, explicitly testing HAR files from WebPageTest, Chrome, and Firefox.
  *Note: Validation uses `vitest` against static pre-rendered `tests/fixtures/` snapshots generated natively by the CLI to enforce immutable verification of streaming decoders.*
- [x] Add decoding, processing, and validation for WebPageTest JSON formats (`src/inputs/wpt-json.js`).
- [x] Add decoding, processing, and validation for Netlog formats (`src/inputs/netlog.js`).
- [x] Add decoding, processing, and validation for Chrome Dev Tools Protocol (CDP) formats (`src/inputs/cdp.js`).
- [x] Add decoding, processing, and validation for Chromium trace formats (`src/inputs/chrome-trace.js`).
- [x] Add pure-vanilla JS streaming decoding and transcoding for binary Perfetto protobuf formats natively mapping to chrome-trace layouts (`src/inputs/utilities/perfetto/decoder.js`).
- [x] Add decoding, processing, and validation for tcpdump formats (`src/inputs/tcpdump.js`), executed in the following sub-steps:
  *(Note: The underlying binary streamer `PcapParser` processes `Uint8Array` chunks natively. PCAPNG support is implemented based on the spec but contains TODOs marking missing IDB timestamp mappings pending `pcapng` file-based tests. The parser itself handles initial structural decoding out to `Ethernet, IPv4/6, TCP, UDP` fields.)*
  - [x] **Capture Parsing:** Parse the capture file into packets.
  - [x] **TLS Key Log Loading:** Load the TLS key log that matches the given tcpdump capture file (or extract embedded key logs from cap file bundles).
    *(Note: Sample key logs are located in `Sample/Data/tcpdump/` alongside the PCAPs. The key log files have the exact same base file name as their corresponding `.cap.gz` captures, but end in `.key_log.txt.gz`.)*
  - [x] **TCP Stream Reconstruction:** Build raw data streams for TCP (with timestamps for each segment) based on src/dest IP/port and SYN/FIN packets. Handle retransmits, overlapping windows, and out-of-order packets.
  - [x] **UDP Stream Reconstruction:** Build virtual connection "streams" for UDP based on packet numbers and src/dest IP/ports.
  - [x] **TCP TLS Decryption:** Decrypt TLS-encrypted TCP streams using the key log, keeping per-chunk timestamps that match packet timings. (Reference RFC specs or utilize/build stand-alone utility libraries for TLS decoding).
  - [x] **TCP Protocol Decoding:** Detect and decode HTTP/1.x, HTTP/2, and DNS over HTTP from unencrypted TCP streams into extractable individual requests (including connection setup and affinity info).
  - [x] **UDP Protocol Detection & QUIC Decryption:** Detect DNS and QUIC formats on UDP. For TLS-encrypted QUIC, decrypt the stream using the keylog.
  - [x] **DNS Decoding:** Decode DNS traffic (from both UDP and TCP/DoH) and store the lookups to add to request timings.
  - [x] **QUIC Decoding:** Decode unencrypted QUIC traffic to extract streams and parse the relevant requests.
  - [x] **Page Entry Creation:** Create a virtual "page" entry. Use the first HTTP request with `Sec-Fetch-Dest: document` as the page URL, defaulting to the first HTTP request if none is found.
  - [x] **HAR Generation & Validation:** Turn the decoded protocols from the tcpdump processing into requests and page data that can be used for generating the HAR format and then the creation and validation of the resulting HAR from the tcpdump input.
- [x] Restructure the `src/inputs` directory so that the core libraries are separated from the cli interfaces and utility functions (in a logical grouping in separate folders) so it's not a flat, giant collection of files. If it makes sense, the core libraries can be at the root.
- [x] **Zero Polyfill Migration:** Convert all node-native stream and crypto logic globally across all input pipelines to purely Web APIs native to Browser engines to ensure a fundamentally lightweight and robust isomorphic library footprint.
- [x] Integrate fallback mapping engine for missing `URL_REQUEST_START_JOB` data from `v8.timeline` categories natively mapping `requestTime` fallbacks.
- [x] Address catastrophic C++ memory address pointer overlapping within `devtools.netlog` array processing inside `chrome-trace`.
- [x] Normalize `CLOCK_MONOTONIC` system uptimes within Chrome Traces to real UNIX epochs dynamically extracting `date:` HTTP response headers preventing 1970 Date object regressions across renderer timeouts.
- [x] Enforce universal monotonic bound isolation handling negative Chrome Trace cache hydration properties smoothly guaranteeing absolute metric spans logically tracking `start <= first_byte <= end` organically.

## Phase 3: The Orchestrator & API
**Goal:** Build the central `conductor` that intelligently manages inputs and acts as the developer API.
- [x] Implement `src/inputs/orchestrator.js` to manage registered source parsers.
- [x] Integrate PCAP/PCAPNG parsing engine via stream transformations.
- [x] Automate test validation matching legacy Python outputs.
- [x] Fix and harden data extraction routines per parser format (e.g. missing HTTP/3 metrics in Traces, fixing `.netlog` chunk mapping references).
- [x] Implement auto-detection logic to identify if a raw input payload is a HAR, Chrome Trace, WPT, or other supported format based on the payload, not the file name (and automatically handle gzipped versions of each).
- [x] Create the `src/core/conductor.js` main class export that coordinates between the auto-detected parser and the intermediary output format. It should support streaming input, raw data and files as input. It should also support the caller providing a key log for TLS decryption and should support a cli for passing in any of the supported file formats and outputting the HAR file (with a `--keylog` option for TLS decryption and a simple, descriptive, short file name).
- [x] Integrate standard `--debug` flag logic and dynamic `options.debug` support across all pipeline parsing execution and viewers ensuring rich telemetry visibility natively.

## Phase 4: Headless Outputs
**Goal:** Generate raw data exports directly from the proven Orchestrator state.
- [x] Implement `src/outputs/simple-json.js` to boil down HAR data to an array of strictly simplified request objects suitable for generic JS usage.
- [x] Create basic unit tests for the HAR input -> Simple JSON output pipeline.

## Phase 5: Core Canvas Renderer & Viewer Enhancements (Browser Platform)
**Goal:** Render a static waterfall chart to a canvas element and implement advanced visual features utilizing the verified data fixtures from Phase 2.
- [x] Implement `src/renderer/layout.js` to calculate row heights, X-axis timestamps, scale distributions and standard WebPageTest color coding.
- [x] Implement `src/renderer/canvas.js` to draw requests as cascading blocks on a provided `<canvas>`.
- [x] Implement logic to leverage `requestAnimationFrame` ensuring efficient updates and redraws. 
- [x] Support global document drag-and-drop targets for seamless file parsing updates.
- [x] Integrate UI Control Overlay in `index.html` mapping settings dynamically seamlessly.
- [x] Include Lighthouse HTML iframe integration inside the viewer organically tied to extended HAR structures.
- [x] Integrate Perfetto Trace Viewer iframe UI securely with dynamic PING layout loading and lazy tab execution.
- [x] Integrate NetLog Viewer iframe UI supporting both standalone files and WPTAgent nested netlogs (`*_netlog.txt.gz`).
- [x] Build Connection View (stacking multiplexed requests organically natively matching WebPageTest features) internally within `layout.js` layout passes.
- [x] Allow bounds clamping for `startTime` and `endTime` zooming natively gracefully.
- [x] Expose `viewer.js` UI states mapping directly into explicit `rendererCanvas.render()` toggle flags allowing dynamic redraws.
- [x] Connect analytical overlays internally mirroring exact original WPT parameters intrinsically:
  - [x] User Timing Marks (vertical markers mapping arbitrary string bounds)
  - [x] CPU Utilization graphs tracking dynamic line layouts
  - [x] Bandwidth Utilization graphs mapped smoothly alongside CPU points
  - [x] Browser Main Thread blocks (coloring Scripting vs Layout loops natively)
  - [x] Long Tasks parsing (highlighting aggressive stalls over 50ms safely).
  - [x] Ellipsis separation for filtered request gaps.
  - [x] Request row label toggles.
  - [x] Individual download chunk timing vs solid bar rendering.
  - [x] JS execution time overlays.
  - [x] Waiting time rendering.

## Phase 6: Client Interactions
**Goal:** Make the canvas waterfall interactive without using individual DOM elements by extending the current `renderTo` API.
- [x] Extend the current `WaterfallTools.renderTo` API to support callbacks (e.g., `options.onHover`, `options.onClick`, `options.onDoubleClick`) for interacting with the waterfall, instead of creating a separate interaction API.
- [x] Focus interactions strictly on the requests part of the waterfall (not the areas outside of the requests like utilization graphs). However, clicks outside of the requests must still trigger interactions (e.g., returning a null request or empty state) so that any external UI or tooltips can be dismissed.
- [x] Implement interaction state tracking so that callbacks only fire when the detail of the interaction has actually changed (e.g., hovering over a different request, clicking, double-clicking).
- [x] Ensure hover notifications correctly send a 'leave' notification when the mouse moves off a request and the new hover location isn't over a new request (including when the mouse leaves the drawing container completely).
- [x] Include the specific request ID (or full context) in the interaction payload in a form that can easily be used to extract further information about the request directly from `WaterfallTools`.
- [x] Map active spatial indexes on screen to corresponding data representations behind the scenes to identify hovering dynamically.
- [x] Update the canvas demo (`src/demo/canvas/`) to display the most recent interaction in a status bar across the top of the page to test and validate these API callbacks.
- [x] Implement X-axis zooming (scaling time bounding) and conditional visibility filtering (e.g. selectively hiding 404s, domains).

## Phase 7: Website Embed Interfaces
**Goal:** Easy drop-in architecture components into fully functioning generic webpages.
- [x] Document the primary `WaterfallTools.renderTo(canvasElement, options)` API as the standard mechanism for web embedding, formally superseding the need for a targeted `div-embed.js` bootstrapping utility.

## Phase 8: Stand-alone Viewer UI
**Goal:** Create a full stand-alone viewer UI that functions independently via a main HTML page or embedded in an iframe.
- [x] Create a main HTML page (`src/viewer/index.html` or similar) for the stand-alone viewer.
- [x] Implement query parameter parsing to accept a `src` parameter containing the URL for a data file to load.
- [x] If a `src` is provided, display a loading UI to provide feedback while fetching data, transitioning directly into the waterfall view once processed.
- [x] If no `src` is provided, display a UI similar to the canvas demo allowing users to load a file manually via an input button or drag/drop.
- [x] Integrate a URL entry bar on the main landing page to automatically load remote traces and update URL parameters for sharing.
- [x] Architect the UI starting with a simple canvas rendering of the waterfall, keeping the structure flexible enough for future feature expansions.
- [x] Map all supported Waterfall renderer options to individual query parameters so they can be explicitly configured via URL.
- [x] Ensure the HTML page operates correctly both as a completely stand-alone viewer (served over HTTP or loaded from a local `file://` URI) and when embedded inside an iframe.
- [x] Expose a JavaScript API from the viewer so that when embedded in an iframe, the hosting page can programmatically "load" data (using any supported loading method) and have the UI run seamlessly as if the file was loaded natively via the `src` parameter.
- [x] Build a dedicated multi-page thumbnail grid view (`tileView`) automatically surfacing metrics (Load, FCP, LCP, Bytes) alongside mini-waterfalls for inputs tracing multiple runs.
- [x] Implement scalable request truncation rendering (`thumbMaxReqs`) utilizing a custom native HTML5 `<canvas>` "torn page" vector overlay to highlight sliced data elegantly without destroying the layout loop limits.
- [x] Add true browser `History API` tracking allowing users to easily traverse back and forward across `tileView` and active waterfall pages using their native browser actions safely.
- [x] Integrate native self-hosted Chrome NetLog and Perfetto Trace viewers as standalone iframe tabs to explore low-level network logging artifacts organically.
- [x] Support drag-and-drop structural rearranging of waterfall viewer tabs paired with horizontal overflow scrolling and visual boundary indicators.
- [x] Polish settings overlay and Viewer UI styling strictly deploying native vanilla CSS components matching a premium presentation.
- [x] Add dynamic tooltip formatting revealing truncated request URLs upon canvas mouse hover bounds.
- [x] Architect dynamic Request Detail Tabs spawned via waterfall request clicks mapping comprehensive headers, timings, sizes, raw JSON configurations, and lazily-loaded interactive visual resource previews natively.
- [x] Extract and link response bodies from nested `_bodies.zip` archives in WPTAgent ZIP inputs, storing them as base64-encoded `response.content.text` on matching HAR entries.
- [x] Prevent OOM crashes on subsequent file Drag-and-Drop operations by thoroughly garbage-collecting blob URLs, discarding dynamic viewer tabs, and safely detaching OPFS storage instances naturally prior to WaterfallTools reconstruction.
- [x] Incorporate project logo and favicon into the landing page for better branding.
- [x] Integrate a generic Service Worker (`sw.js`) implementing a Stale-While-Revalidate caching strategy enabling offline operation for the standalone viewer.

## Phase 8b: Progress Reporting & Async Performance
**Goal:** Prevent browser "script taking too long" dialogs and provide user feedback during large file processing.
- [x] Add `options.onProgress(phase, percent)` callback support to all input parsers for real-time progress reporting.
- [x] Insert `setTimeout(0)` yield points between major processing phases and within long synchronous loops in the tcpdump parser.
- [x] Pass `totalBytes` automatically from `loadBuffer()` so parsers can estimate stream-reading progress.
- [x] Fix O(n²) base64 body encoding in `tcpdump.js` and `wptagent.js` (replaced char-by-char `String.fromCharCode` loop with chunked `String.fromCharCode.apply` + `join`).
- [x] Add CSS-animated progress bar UI to the standalone viewer (`#progress-container`, `#progress-bar`).

## Phase 8c: Per-Chunk Uncompressed Sizes
**Goal:** Plumb decoded/uncompressed byte counts into `_chunks` across every data source that can produce them, enabling downstream tools to slice the decompressed response body by chunk delivery time.
- [x] Preserve `inflated` on netlog `_chunks` (already captured from `URL_REQUEST_JOB_FILTERED_BYTES_READ`) through the full HAR pipeline.
- [x] Preserve `inflated` on WPT JSON / wptagent `_chunks` via the generic `_`-prefix property mapping in `wpt-json.js`.
- [x] Add `inflated` to CDP `_chunks` from `Network.dataReceived.dataLength` vs `encodedDataLength`.
- [x] Add `inflated` to tcpdump `_chunks` via streaming decompression — each wire chunk is written individually to a `DecompressionStream` (gzip/deflate/brotli) or an `fzstd.Decompress` stream (zstd) and the exact number of decompressed bytes emitted per wire chunk is recorded. No proportional fallback: when streaming isn't available (pure-JS brotli), `inflated` is omitted.
- [x] Add `decompressBodyPerChunk(wireChunks, encoding)` helper to `src/core/decompress.js` and wire it into the tcpdump parser via `options.deps.decompressBodyPerChunk` through both `orchestrator.js` and `cli/tcpdump.js`.
- [x] Document the `_chunks[].inflated` contract in `Docs/Extended-HAR-Schema.md` and `AGENTS.md`.

## Phase 9: Environment Adapters & Image Generation
**Goal:** Allow creating static images and ensure robust server-side context scaling.
- [x] Add explicit platform abstraction definitions within `src/platforms/`.
- [x] Prepare Node integrations targeting offscreen canvas or node-canvas counterparts.
- [x] Implement `src/outputs/image.js` to digest render data straight into raw image buffer sets / Base64 serialization outputs snapshotting views.
- [x] Restructure and optimize Vite build pipeline statically generating exactly three decoupled bundle artifacts resolving fragment bounds inherently natively.
- [x] Integrate Touch Events and native Responsive layout mappings structurally accommodating mobile targets logically.
