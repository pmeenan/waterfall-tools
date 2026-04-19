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
- [x] Detect WebPageTest test URLs pasted into the URL entry bar and automatically transform them to fetch the HAR payloads via export.php.
- [x] Architect the UI starting with a simple canvas rendering of the waterfall, keeping the structure flexible enough for future feature expansions.
- [x] Map all supported Waterfall renderer options to individual query parameters so they can be explicitly configured via URL.
- [x] Ensure the HTML page operates correctly both as a completely stand-alone viewer (served over HTTP or loaded from a local `file://` URI) and when embedded inside an iframe.
- [x] Expose a JavaScript API from the viewer so that when embedded in an iframe, the hosting page can programmatically "load" data (using any supported loading method) and have the UI run seamlessly as if the file was loaded natively via the `src` parameter.
- [x] Build a dedicated multi-page thumbnail grid view (`tileView`) automatically surfacing metrics (Load, FCP, LCP, Bytes) alongside mini-waterfalls for inputs tracing multiple runs.
- [x] Implement scalable request truncation rendering (`thumbMaxReqs`) utilizing a custom native HTML5 `<canvas>` "torn page" vector overlay to highlight sliced data elegantly without destroying the layout loop limits.
- [x] Add true browser `History API` tracking allowing users to easily traverse back and forward across `tileView` and active waterfall pages using their native browser actions safely.
- [x] Implement a "Waterfall History" service leveraging IndexedDB to silently track URL-based loads and metadata (type, title, timestamps) for future UI integrations.
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

## Phase 8d: Chunked HTML Response Body Viewer
**Goal:** Visualize *what arrived when* by rendering chunked HTML responses as a hex-viewer-style table in the standalone viewer's request inspector.
- [x] Add `buildChunkedHtmlBody(request, waterfallZero)` in `src/viewer/viewer.js` that decodes the base64 body once, slices by `inflated` byte counts (falling back to wire `bytes` when absent per AGENTS note 72), and reassembles UTF-8 across chunk boundaries via streaming `TextDecoder`.
- [x] Wire the helper into `renderRequestTab` for HTML responses, resolving `waterfallZero` exactly the way `layout.js#L159-L176` does: prefer `pageData.startedDateTime` epoch ms, fall back to scanning the page's entries for the earliest `time_start`. Falls back transparently to the standard single-block view when chunks lack timestamps or the body can't be decoded.
- [x] Add CSS for the `.req-chunked-body` table layout in `src/viewer/style.css` — alternating row shading, 56px min-height for label visibility, narrow flex left column for timestamps + sizes, wide flex right column for syntax-highlighted body slices.
- [x] Per-row label format `[absTime] ms ([±deltaTime] ms)` — `absTime` is the chunk's position on the canvas axis, `deltaTime` is the inter-arrival gap (first chunk: from the request's load start, subsequent chunks: from the previous chunk). Size labels show inflated alongside wire bytes for compressed responses (`870.05 KB · 14.06 KB wire`).
- [x] Per-chunk body cells are vertically unconstrained (`max-height: none; overflow: visible`) so the request tab's outer scroll handles overall navigation and the reader sees a continuous unbroken document instead of fighting nested per-row scrollbars.

## Phase 8e: Netlog `timeTickOffset` Page Anchor Fix
**Goal:** Fix a long-standing netlog bug where the page `startedDateTime` would land in 1970 because the parser misread the monotonic tick `start_time` as UNIX epoch seconds.
- [x] Capture `constants.timeTickOffset` (Chrome's wall-clock anchor for tick 0, in epoch ms) in `Netlog#setConstants` and propagate it through `postProcessEvents()` results.
- [x] Compute `pageStartEpochMs = timeTickOffset + start_time` in `processNetlogFileNode` and pass it to `normalizeNetlogToHAR`.
- [x] Rename `normalizeNetlogToHAR`'s last parameter from `run_start_epoch` (interpreted as seconds) to `page_start_epoch_ms` (real wall-clock epoch ms) and remove the `* 1000` multiplication.
- [x] Update `chrome-trace.js`'s call site to pass `final_start_time` directly (it was already in ms after the HTTP `date:` header offset hack, but had to be `/ 1000.0`'d for the old seconds API).
- [x] Regenerate the netlog golden fixtures (`tests/fixtures/netlog-google.har.json`, `netlog-amazon1.har.json`) — diff is anchor-only, every relative `_*` field is unchanged.

## Phase 8f: CORS Fetch Proxy (Cloudflare Worker)
**Goal:** Provide a deploy-ready, self-contained Cloudflare Worker that acts as a CORS-friendly fetch fallback for URL-based imports when remote origins do not send `Access-Control-Allow-Origin` headers — without becoming an open proxy.
- [x] Create the `cloudflare-worker/` top-level directory containing `worker.js` (single-file module Worker), a minimal `wrangler.toml`, and a deployment `README.md`.
- [x] Gate all Worker logic behind `url.pathname === '/fetch'`; every other path passes through unmodified via `fetch(request)`.
- [x] Parse the `url` query parameter, validate it's an absolute `http(s)://` URL, and block obvious SSRF targets (loopback, RFC 1918, link-local, CGNAT, `localhost`/`.local`/`.internal`, IPv4-mapped IPv6) before any upstream fetch.
- [x] Forward the caller's real IP via `X-Forwarded-For` (appending to existing chain), `X-Real-IP`, `Forwarded` (RFC 7239 quoted), and a `Via: 1.1 waterfall-tools-proxy` header so the proxy is intentionally non-anonymizing.
- [x] Read the first 64 KB of the upstream response, run the same format-sniff logic as `src/inputs/orchestrator.js#identifyFormatFromBuffer` (inlined into the Worker so it stays a single file), and reject with `415 unsupported_format` anything that isn't a recognised waterfall-tools input.
- [x] Stream the matched body back to the caller by replaying the buffered sniff chunks (one-per-pull for backpressure) followed by unmodified pass-through of the remaining `reader.read()` output. No reassembly, no content transformation; `Content-Encoding` / `Content-Type` / `Content-Length` / `ETag` / `Last-Modified` / `Cache-Control` are copied verbatim.
- [x] Add `Access-Control-Allow-Origin: *` (and `Access-Control-Expose-Headers` for the format label) so anonymous-mode `fetch()` works against the proxy.
- [x] Implement per-IP failure rate limiting using an in-memory `Map<string, {count, firstFailureMs}>` keyed by `CF-Connecting-IP` (default 10 failures per 10 minutes → 429 until the window rolls over), with a map-size cap (default 10 000 entries). When the cap is reached and every tracked entry is still within its active window, refuse to evict (preventing unique-IP flood attacks from silently rolling real offenders off the FIFO) and **fail-closed**: reject all `/fetch` requests with 429 until the oldest tracked entry ages out.
- [x] Reject `HEAD` on `/fetch` because there's no body to sniff; handle `OPTIONS` preflights with the appropriate CORS headers.
- [x] Enforce an upstream fetch timeout via `AbortController` and a Content-Length cap to keep Worker CPU/memory bounded.
- [x] Document the lockstep sync requirement: every new input format added to the orchestrator MUST also be added to the Worker's sniff logic (`AGENTS.md` §76, `cloudflare-worker/README.md`).

## Phase 8g: Main Thread Activity Flame Chart
**Goal:** Restore the WebPageTest-style "Browser Main Thread" flame chart so `showMainthread` produces a rendered visualization rather than an empty reserved band. Starts with wptagent inputs (which ship pre-computed per-slice histograms in `[run]_timeline_cpu.json.gz`); other sources to follow in a later phase.
- [x] Define `_mainThreadSlices` on the Extended HAR page object: `{slice_usecs, total_usecs, slices}` where `slices` maps each of five canonical categories (`ParseHTML`, `Layout`, `Paint`, `EvaluateScript`, `other`) to an array of integer microseconds per slice. Document in `Docs/Extended-HAR-Schema.md` and `src/core/har-types.js`.
- [x] In `src/inputs/wptagent.js`, parse `[run][_Cached]_timeline_cpu.json[.gz]`, keep only the primary `main_thread` arrays, fold raw trace-event names into the five canonical categories via `MAIN_THREAD_CATEGORY_MAP` (mirrored from `Sample/Implementations/webpagetest/www/waterfall.inc` L437-L491), and attach to the matching HAR page by `_run` / `_cached`.
- [x] Extend `src/renderer/layout.js#calculateRows` so `hasMainthread` also reserves height when `_mainThreadSlices` is present (not only legacy `_browser_main_thread`).
- [x] Implement the flame-chart draw loop in `src/renderer/canvas.js`: for every pixel of the data area, aggregate `usecs` per category across the slices falling under that pixel, and stack colored bars bottom-up in fixed order `ParseHTML → Layout → Paint → EvaluateScript → other` using the reference WPT palette.
- [x] Keep the legacy `_browser_main_thread` / `_mainThreadEvents` block-based rendering as a fallback when slices are absent.
- [x] Add vitest coverage in `tests/inputs/wptagent.test.js` for category folding, slice-count parity across types, and per-slice-value bounds.

## Phase 8h: wptagent CPU / Bandwidth / JS-Execution Feeds
**Goal:** Restore the three remaining WebPageTest overlay bands (CPU utilization, bandwidth graph, per-request JS execution) for wptagent zip imports.
- [x] Fix `[run][_Cached]_progress.csv` → `page._utilization` attachment: match pages by `_run`/`_cached` (the existing string-concat on `page_${run}_${cached}` missed the `_1` suffix minted by `processWPTView`, so CPU and BW arrays never reached the renderer).
- [x] Parse `[run][_Cached]_script_timing.json[.gz]` in `src/inputs/wptagent.js`. Flatten the allowlisted event pairs (`EvaluateScript`, `v8.compile`, `FunctionCall`, `GCEvent`, `TimerFire`, `EventDispatch`, `TimerInstall`, `TimerRemove`, `XHRLoad`, `XHRReadyStateChange`, `MinorGC`, `MajorGC`, `FireAnimationFrame`, `ThreadState::completeSweep`, `Heap::collectGarbage`, `ThreadState::performIdleLazySweep`) from the `main_thread` subtree into `entry._js_timing = [[start_ms, end_ms], ...]`. Attach by `_full_url` equality, first-match-wins (matches the `$used` de-dup at `Sample/Implementations/webpagetest/www/waterfall.inc#L2004-L2011`).
- [x] Regression coverage in `tests/inputs/wptagent.test.js` for utilization-per-page population and js_timing attachment on the primary document.

## Phase 8i: Chrome Trace Main-Thread Flame Chart + JS-Execution Port
**Goal:** Make raw Chrome trace imports produce the same flame-chart and per-request JS-execution overlays that wptagent zips already do. Port of `Trace.ProcessTimelineEvents` / `WriteCPUSlices` / `WriteScriptTimings` from `Sample/Implementations/wptagent/internal/support/trace_parser.py` (the reference parser the rest of the waterfall/PHP renderer was built against).
- [x] Extract `MAIN_THREAD_CATEGORY_MAP`, `SCRIPT_TIMING_EVENTS`, and `foldCpuSlices` from `src/inputs/wptagent.js` into `src/core/mainthread-categories.js` so `chrome-trace.js` can share the same five-category fold and allowlist without a circular dep.
- [x] Replace the flat `main_thread_events` accumulator in `chrome-trace.js` with a slim raw-timeline event capture (only `{ph, ts, dur, name, pid, tid, data:{url,scriptName,isMainFrame}}`) plus thread-metadata tracking (`thread_name`, `process_labels`→Subframe, `isMainFrame`/`ResourceSendRequest+url` main-thread signals).
- [x] Add `buildMainThreadActivity(rawEvents, baseUs, startUs, metaMainThreads, subframePids)` in `chrome-trace.js` that sorts by ts, replays a per-thread B/E stack, selects the main thread by cumulative slice CPU among CrRendererMain + explicit candidates, computes fractional per-name slices with `AdjustTimelineSlice` parent-subtraction, extracts script timings per `{thread, url, name}` with ancestor-stack de-dup, and emits long tasks ≥ 50 ms.
- [x] Key slices off `base_time_microseconds` (HAR page zero), not `start_time`: Chrome traces can hold netlog events before navigationStart, and canvas x=0 must align with slice index 0.
- [x] Drop the "pin to first navigationStart thread" override — the chrome://tracing DevTools renderer fires its own `navigationStart` first when the trace is hosted in DevTools, which stole the main-thread pick from the actual content renderer (theverge / engadget manifested as ~10 µs totals with zero JS overlays).
- [x] Emit `page._mainThreadSlices` (via `foldCpuSlices`), `page._longTasks`, and `entry._js_timing` — drop the legacy `_mainThreadEvents` output. Regenerate chrome-trace fixtures.

## Phase 8j: Chrome Trace Request Quality Filter
**Goal:** Stop emitting HAR entries for Chrome trace URL_REQUESTs that never produced real network activity (cache hits, cancelled preloads, redirect placeholders, DevTools panel self-traffic). Reflects the contract that netlog is the source of truth when present and timeline is an enrichment; timeline-only synthesis is gated on genuine send+receive evidence.
- [x] Filter netlog-derived requests in `chrome-trace.js` to those with `start !== undefined` AND at least one of `response_headers`, `first_byte`, `bytes_in > 0`, or `end > start`. Drops ~90% of the garbage rows typical netlog traces carry (amazon.com: 937→87 real).
- [x] Drop recording-harness and DevTools UI URLs unconditionally (`http://127.0.0.1:8888`, `chrome://tracing`, `chrome-extension://`).
- [x] Augment netlog requests from `devtools.timeline` only — never overwrite netlog's `start/first_byte/end` / `bytes_in` / `request_headers`. Inherit `statusCode` from `ResourceReceiveResponse` when netlog's stored `response_headers` lacked a parseable HTTP/`:status` line (H2/QUIC pseudo-header stripping).
- [x] Track `has_real_id` on timeline requests — URL-keyed `blink.resource` prefetch probes never produce HTTP transactions and must be excluded from synthesis. Also track `was_sent` (ResourceSendRequest fired), `had_response` (ResourceReceiveResponse fired), `from_cache` / `from_service_worker` (skip; those never hit the wire).
- [x] Gate timeline-only synthesis on: real requestId + was_sent + not from cache / SW + URL is non-noise + not already represented by a netlog request + (full timing block OR had_response with status > 0).
- [x] Cover the no-netlog path with a dedicated fixture (`trace_www.google.com-no-netlog`); scrub dynamic `_*TimeMs` absolute-epoch fields from snapshot comparisons because that path falls back to `Date.now()` for its wall-clock anchor.
- [x] Long-task detection now merges two sources: the existing `devtools.timeline` top-of-stack ≥ 50 ms signal (covers wptagent captures) AND `toplevel` / `ipc,toplevel` RunTask durations ≥ 50 ms restricted to main-thread candidates (covers DevTools Performance panel captures whose long work lives in RunTask wrappers, not individual timeline events). Toplevel tasks are filtered and captured during JSON streaming to bound memory, then merged post-walk and re-coalesced. Amazon: 0 → 1 long task; theverge: 3 → 6; cnn: 0 → 1; engadget: 1 → 2.
- [x] `_longTasks` presence is now a tri-state signal: array with entries (long tasks detected, red spans on green), empty array (parser ran and found none, fully-green band), or absent (parser doesn't instrument long tasks, band row suppressed). `layout.js#calculateRows` and `canvas.js` gate rendering on `Array.isArray(p._longTasks)` rather than `.length > 0`. Parsers that add long-task support **must** emit `[]` rather than `undefined` on empty.

## Phase 8k: Embedded Chrome DevTools Frontend
**Goal:** Host the Chrome DevTools UI inside the viewer (alongside the existing Perfetto and NetLog iframes) so traces can be explored with the same tooling Chromium ships with. This phase only wires up the embedding — routing trace buffers into the DevTools Performance panel lands in a follow-up phase.
- [x] Add `@chrome-devtools/index` (MIT, prebuilt DevTools UI bundle) as a runtime dependency. The upstream `chrome-devtools-frontend` package is source-only and requires the Chromium toolchain to build, so it's deliberately not used.
- [x] Production build: `scripts/build.js` reads the dependency's `package.json` version, copies the bundle to `dist/browser/devtools-<version>/`, and rewrites `<meta name="waterfall-devtools-path" content="…">` in the viewer index to point at the versioned directory. The build path excludes the directory from Brotli pre-compression (79 MB of already-optimized third-party assets dominate level-11 compression time).
- [x] Dev build: a vite plugin in `vite.dev.config.js` reads the same version, serves `/devtools-<version>/*` from `node_modules/@chrome-devtools/index/`, and `transformIndexHtml` populates the same meta tag — so the source HTML stays unchanged and the URL shape matches production.
- [x] Viewer UI: new "DevTools" tab (`src/viewer/index.html`), new `getDevtoolsPath()` + `loadDevtools()` (`src/viewer/viewer.js`), overlay CSS (`src/viewer/style.css`). The tab is gated on `getPageResource(pageId, 'trace')` returning a buffer — same gate that exposes the Perfetto tab — so any test result that currently shows Perfetto also exposes DevTools.
- [x] Rename the "Trace" tab to "Perfetto" so the two trace-backed tabs read as "Perfetto" and "DevTools".
- [x] Document in `AGENTS.md` (§ "Chrome DevTools frontend") that the dependency must be bumped every project work session (`npm install --save @chrome-devtools/index@latest`) and that the version propagates through the build automatically — never hard-code it.
- [x] **Trace load-in** — `?panel=timeline` in the iframe URL makes Performance the default panel, which lazily constructs `TimelinePanel` and registers it on `self.UI.panels.timeline`. After the iframe load event, poll until the panel is ready, then call `panel.loadFromFile(new cw.File([buffer], name, {type}))`. `TimelinePanel.loadFromFile` internally decompresses gzip (when `file.type` ends with `gzip`), `JSON.parse`s, and hands the parsed object to `TimelineLoader.loadFromParsedJsonFile` — the same path the DevTools file-picker takes.
- [x] **Perfetto protobuf transcoding** — `sniffTraceContent()` peeks the first decompressed chunk to distinguish JSON vs protobuf (a gzipped `.perfetto` looks like gzipped JSON to a header-only sniffer and was silently malformed-data'd by DevTools previously). Perfetto inputs go through `transcodePerfettoToGzippedJson()`: source `ReadableStream` → optional `DecompressionStream('gzip')` → `PerfettoDecoder().stream` → `TextEncoderStream` → `CompressionStream('gzip')` → `Blob`, then handed to the same `loadFromFile` path with `application/gzip` MIME. The on-the-fly gzip on the way out keeps memory peak at ~5–10× smaller than the inflated JSON; DevTools' own `Common.Gzip.fileToString` does the inflation lazily during the load. `PerfettoDecoder` is re-exported from `src/core/waterfall-tools.js` so the viewer can import it via the bare specifier. `TimelineLoader` exposes no streaming entrypoint that avoids materializing the full event array — `loadFromEvents` / `loadFromTraceFile` / `loadFromParsedJsonFile` all concat into one in-memory array, and `loadFromURL` dumps to a `StringOutputStream` and `JSON.parse`s — so `loadFromFile` + gzipped Blob remains the lowest-memory path available.

## Phase 9: Environment Adapters & Image Generation
**Goal:** Allow creating static images and ensure robust server-side context scaling.
- [x] Add explicit platform abstraction definitions within `src/platforms/`.
- [x] Prepare Node integrations targeting offscreen canvas or node-canvas counterparts.
- [x] Implement `src/outputs/image.js` to digest render data straight into raw image buffer sets / Base64 serialization outputs snapshotting views.
- [x] Restructure and optimize Vite build pipeline statically generating exactly three decoupled bundle artifacts resolving fragment bounds inherently natively.
- [x] Integrate Touch Events and native Responsive layout mappings structurally accommodating mobile targets logically.
