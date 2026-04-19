# Waterfall Tools: AI Agent Guidance

Client-side, high-performance network waterfall library (WebPageTest-style).

## Workflow (mandatory)

- **Start:** read `Docs/Architecture.md` and `Docs/Plan.md`.
- **End:** update `README.md`, `Docs/Plan.md`, `Docs/Architecture.md`, and `AGENTS.md` (this file is long-term project memory).
- **Hygiene:** delete any throw-away diagnostic scripts, `.log` files, and scratch outputs from the repo root before concluding.
- **API changes** to public signatures (`WaterfallTools` methods, `renderTo()` options) MUST be reflected in `README.md` and noted here.

## Core architecture

- Vanilla JS only in library core. No React/Vue/Svelte/Angular. External libs allowed if they improve the architecture.
- Use `<canvas>` for waterfalls — no per-request DOM elements (1000+ requests are common).
- Every input format maps to **Extended HAR** before rendering or output. HAR `log.creator` must identify `waterfall-tools`. Custom fields prefix with `_` (e.g. `_priority`, `_load_ms`, `_ttfb_ms`, `_bytesIn`). Schema: `Docs/Extended-HAR-Schema.md`. Types: JSDoc in `src/core/har-types.js`.
- Pluggable, decoupled modules. Orchestrator transports verified HAR across renderers/outputs without implicit mutation. Tree-shakeable exports.
- Target: latest stable Chrome, Firefox, Safari, Node. No polyfills or transpilation. UMD abandoned — ESM only.
- Licenses: MIT / BSD / Apache-2 / ISC / MPL only. **No GPL** in any form.

## File layout / isomorphism

- `src/core/` and top-level `src/inputs/*.js` — strictly isomorphic (Node + browser).
- `src/inputs/cli/[format].js` — CLI wrappers (Node-only, keeps bundlers away from `process.*`).
- `src/inputs/utilities/[format]/` — format-specific decoders.
- `src/platforms/browser/`, `src/renderer/`, `src/embed/` — Web APIs only.
- `src/platforms/node/` — Node APIs only (`fs`, `zlib`, `crypto` dynamic-imported from isomorphic code).
- Structure must allow dropping in WASM for heavy future work (trace decompress, frame unpacking).

## Build

- Rollup, not Rolldown. Outputs: `waterfall-[hash].js`, `tcpdump-[hash].js`, `decompress-[hash].js`, plus a 41-byte `waterfall-tools.es.js` stub that imports the hashed payload (enables 1-year max-age caching).
- Static artifacts have Brotli `.br` counterparts, level 11.
- Orchestration: `scripts/build.js`.
- Viewer uses `<script type="importmap">` pointing `waterfall-tools` → `dist/browser/waterfall-tools/waterfall-tools.es.js`. `vite.dev.config.js` aliases the bare specifier to `src/core/waterfall-tools.js` for HMR (`npm run dev:viewer`).

## Testing

- **vitest only** (`import { describe, it, expect } from 'vitest'`). Not `node:test`/`assert`. Files: `tests/**/*.test.js`.
- Before `deepStrictEqual`-style asserts on large objects, sanitize via `JSON.parse(JSON.stringify(result))` — `undefined` mismatches hang the runner.
- Scrub dynamically generated keys (e.g. `startedDateTime` from `Date.now()` fallbacks) from both sides before comparing.
- Tests implicitly set `{ debug: true }`.
- For formats with parallel sources (e.g. netlog vs HAR from the same test), match samples by filename prefix convention (e.g. `www.google.com-netlog.json.gz` ↔ `www.google.com.har.gz`).

## Sample assets

- `Sample/Data/[format]/[source]/` — format-segmented inputs.
- `Sample/Implementations/[format]/` — exploratory/reference parsers (e.g. Python).
- `Sample/Data/wptagent/roadtrip-wptagent.zip` — canonical reference: all collectable types, first+repeat view.

## Orchestrator & public API

- `src/inputs/orchestrator.js` auto-detects format by magic bytes / token sniffing. Callers don't pass format.
- Every parser signature: `processXNode(input, options)` accepting either file path or `Readable`.
- `Conductor` class exposes `processFile` and `processStream`.
- Unified CLI: `bin/waterfall-tools.js`. Auto-discovers matching `keylog` files.
- All entry points honour `options.debug` → structured `console.log`/`error` telemetry. Default off for zero production cost.
- `options.onProgress(phase, percent)` — every parser supports it. Tcpdump reports fine-grained phases; other parsers report `bytesRead/totalBytes`. `totalBytes` injected by `loadBuffer()`.
- **Dependency injection:** orchestrator passes `options.deps` (`decompressBody`, `decompressBodyPerChunk`, `sniffMimeType`). CLI harnesses (`src/inputs/cli/tcpdump.js`) must populate these. Recursively pass `options` through nested async extraction calls.

## Fault tolerance & streaming

- Parsers degrade gracefully on truncated/malformed input.
- Use **Web Streams API** (`ReadableStream`, `DecompressionStream`, `TextDecoderStream`). JSON via `@streamparser/json`. Never `JSON.parse` large payloads.
- Transform streams to drop massive fields (`generated-html`, `almanac`) at token level before the JSON assembler — prevents V8 OOM.
- Detect gzip by magic bytes (`1f 8b`), not `.gz` extension.
- In Node bridges, manually `.destroy()` `fs.ReadStream` instances in `finally` after `getReader().read()` — Web streams don't auto-close file handles.
- When bridging events across arrays with 15K+ entries, index by `Map` (avoid O(n²)).
- Clone chunk arrays (`JSON.parse(JSON.stringify(...))`) before mutations that subtract relative offsets — by-reference sharing across parser paths corrupts timestamps irreversibly.
- Format sniff bounds: at least 64KB (`logEventTypes` in netlog appears ~byte 4500). WPT JSON: check `testRuns`, `average` etc. — not just `runs`/`median`.
- Dual-file drops (viewer): run `identifyFormatFromBuffer` on every dropped file, not name matching. Keylogs contain `CLIENT_RANDOM` or `CLIENT_TRAFFIC_SECRET_0`.

## Timestamp / clock normalization

The canvas renderer expects **relative millisecond offsets** from the earliest `startedDateTime` in the collection. Mis-normalized absolute epochs (seconds vs ms, or monotonic uptime) cause `requestAnimationFrame` loops to iterate trillions of times and crash the tab. Per-parser rules:

- **Chrome Trace:** `trace_event.ts` is **microseconds**; divide by 1000 before HAR generation. Extract real epoch from the first HTTP `date:` response header (CLOCK_MONOTONIC otherwise). Compute entry dates as `new Date(baseEpochMs + req.startMs)`, never `new Date(seconds)`. Missing `requestTime` → bypass synthesis, don't emit NaN. Clamp `req.end = max(req.end, req.start)` to handle cached/prefetched responses where `ResourceFinish` precedes `requestTime`. When using `timeline_requests` for base, `tl.timing.requestTime` is **seconds** (vs `tl.requestTime` in ms) — multiply by 1e6 for µs comparisons.
- **CDP:** `timestamp` is seconds — `(ts - first_ts) * 1000`. `response.timing.{dnsStart,connectStart,...}` are ms offsets relative to `requestTime` — add to absolute start time. Aborted/blocked requests with no `endTime` → scrub with `errorCode = 12999`.
- **Netlog:** monotonic event ticks in ms. `constants.timeTickOffset` is epoch ms string for tick 0. Parser stores `this.timeTickOffset` and returns from `postProcessEvents()`. `processNetlogFileNode` resolves `pageStartEpochMs = timeTickOffset + earliest_tick` and passes it to `normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, page_start_epoch_ms)` as a real epoch ms anchor (historical bug: treating ticks as seconds produced `1970-07-15` dates that silently broke `> 1e12` heuristics downstream).
- **Chrome Trace via netlog pipe:** passes its own pre-resolved epoch ms baseline directly — no divisor needed.
- `normalizeNetlogToHAR` bulk-copies `req.X` onto `entry._X`. Per-request `_dns_start` / `_connect_start` / `_ssl_start` only populate for entries where those phases happened on this request's URL_REQUEST (redirects). Reused-connection entries pull connection-level timings from `data.tcp_connections` / `data.quic_connections` via `connection_id`.

## Parser-specific rules

### Chrome Trace
- **Source-of-truth contract:** when the trace carries `cat: netlog` events, netlog is the definitive request source and `devtools.timeline` only enriches (priority, renderBlocking, initiator, statusCode fallback, JS-execution overlays). When netlog is absent, timeline is the only source and a stricter quality gate applies. Tracked via `netlog_event_count` during JSON streaming.
- **Netlog request filter (`netlogRequestHasNetworkActivity`):** keep a URL_REQUEST only when `start !== undefined` AND at least one of `response_headers`, `first_byte`, `end > start`, `bytes_in > 0`. Drops cache hits, cancelled preloads, redirect placeholders, and URL_REQUEST entries that never reached `HTTP_TRANSACTION_SEND_REQUEST`. Typical amazon.com trace goes from 937 raw URL_REQUESTs → 87 real network entries.
- **Noise URL filter (`isNoiseUrl`):** unconditionally drop `http://127.0.0.1:8888` (wptagent bootstrap), `chrome://tracing` (DevTools panel self-traffic), and `chrome-extension://` (browser extensions). Applied in both netlog filtering and timeline synthesis.
- **Timeline-only synthesis gate:** a `timeline_requests[id]` is only promoted to a HAR entry when all of these hold: (1) `has_real_id` — was seen with a `args.data.requestId` (not just a URL-keyed `blink.resource` prefetch probe); (2) `was_sent` — ResourceSendRequest fired; (3) has `requestTime`; (4) URL is not noise; (5) URL is not already covered by a netlog request; (6) `from_cache` / `from_service_worker` are both false; (7) EITHER `tl_req.timing.requestTime` populated (full connect/dns/ssl breakdown) OR `had_response` with `status > 0`. No other combination is considered proof of a real HTTP transaction.
- **Netlog statusCode fallback:** when a netlog request's `response_headers` lack a parseable HTTP/`:status` line (H2/QUIC pseudo-header stripping in some Chrome builds), inherit the statusCode from the URL-matched timeline's `ResourceReceiveResponse.data.statusCode`. Otherwise `normalizeNetlogToHAR` sinks the entry to status `-1`.
- `id2.local` is a C++ pointer — reused across disjoint request lifecycles. **Must** intercept `URL_REQUEST_START_JOB` / `REQUEST_ALIVE` `ph="b"` boundaries and mint a new internal id per "begin"; subsequent events on the shared `id2.local` map to the active multiplexed id.
- Headers in `devtools.timeline` are serialized as objects — normalize to `["Name: Value"]` string arrays when bridging into `netlog.js`.
- Don't require `req.end` / `req.request_headers` to be present when attaching netlog state across identical URLs.
- Main-thread flame chart + per-request JS execution come from `buildMainThreadActivity` in `chrome-trace.js`, a direct port of `Trace.ProcessTimelineEvents` / `WriteCPUSlices` / `WriteScriptTimings` in `Sample/Implementations/wptagent/internal/support/trace_parser.py`. Raw `devtools.timeline` / `blink.resource` events are captured during JSON streaming into a slim `raw_timeline_events` array (only `{ph, ts, dur, name, pid, tid, data:{url,scriptName,isMainFrame}}` — keeping full `args` OOMs theverge-sized traces). After streaming the array is sorted by `ts` and replayed through a per-thread B/E stack. Slice size is the largest `10^n` µs that still gives >2000 slices, matching the Python heuristic.
- Slice origin is **`base_time_microseconds`** (HAR page zero), not `start_time`. Chrome traces can hold netlog events that precede navigationStart, so keying slices off the page zero aligns slice index 0 with canvas x=0. Python uses `self.start_time` only because wptagent's `time_start == start_time`; that identity doesn't hold for raw Chrome traces. Event-filter guard still uses `ts >= start_time` (navigationStart) to drop pre-nav stack noise.
- Main-thread candidate pool = every `CrRendererMain` (from `__metadata thread_name`) ∪ every thread that fires `isMainFrame:true` or `ResourceSendRequest`-with-url ∪ the first `navigationStart` / `fetchStart` thread. Final pick is the candidate with the most cumulative slice CPU — **don't** pin to the first navigationStart thread. When chrome://tracing hosts the trace, the DevTools renderer fires `navigationStart` for its own `get_buffer_percent_full` fetches before the real content renderer navigates, and pinning would steal the pick. Historical bug: theverge / engadget rendered ~10 µs totals (DevTools UI thread) with zero JS-execution overlays until this was fixed.
- JS attribution (mirrors trace_parser.py L590-L600): `EvaluateScript` / `v8.compile` / `v8.parseOnBackground` use `args.data.url`; `FunctionCall` prefers `scriptName`, falls back to `url` (fragment-stripped). Output lands on `entry._js_timing = [[start_ms, end_ms], ...]` relative to page zero, first-match-wins by `_full_url` equality (same `$used` de-dup as wptagent).
- Long tasks: two sources, then coalesced into `page._longTasks = [[ms_start, ms_end], ...]`.
  - **Primary:** top-level (parent-less) events ≥ 50 ms on any main-thread candidate in the `devtools.timeline` / `blink.resource` stack replay. This is what wptagent traces produce naturally because wptagent's chosen trace categories emit those child events directly.
  - **Secondary:** `toplevel` / `ipc,toplevel` `RunTask` events (e.g. `ThreadControllerImpl::RunTask`, `ThreadPool_RunTask`) ≥ 50 ms restricted to main-thread candidates. Required for traces captured via the Chrome DevTools Performance panel, where all `devtools.timeline` events are short children of a long RunTask — filtering RunTasks away (as `trace_parser.py#L241` does) would miss every long task on that capture path. Only ≥ 50 ms tasks are retained during streaming to keep memory bounded on large traces. Explicitly excluded from slice aggregation because nesting RunTasks with their devtools.timeline children would double-count CPU; only used for long-task detection.
  - Post-merge pass re-sorts and coalesces overlapping intervals across both sources.
  - **Presence semantics:** `_longTasks` is set to `[]` when the stack-replay ran but observed nothing ≥ 50 ms, and omitted entirely when the parser can't instrument long tasks at all. The renderer (`layout.js`, `canvas.js`) uses `Array.isArray(p._longTasks)` as the "supported" signal — an empty array draws the full-width green interactive band, a missing field suppresses the band row. Parsers that add long-task support **must** always emit `[]` rather than `undefined` when they ran but found nothing.
- Shared 5-category fold map + script-event allowlist live in `src/core/mainthread-categories.js` (`MAIN_THREAD_CATEGORY_MAP`, `SCRIPT_TIMING_EVENTS`, `foldCpuSlices`). Both `chrome-trace.js` and `wptagent.js` import from there — keep them in sync with the reference at `Sample/Implementations/webpagetest/www/waterfall.inc#L437-L491` and `#L1976-L1993`.

### WPT JSON
- Multiple pages per `log` (First View, Repeat View). Renderers must filter `log.entries` by active `pageObj.id` before layout.
- WPT parsers must set `_run` (int) and `_cached` (0/1) on each `page` so `getPageResource()` can locate `*_Cached_screen.jpg` etc.
- `chunks` is polymorphic: legacy WPT → `{ts: bytes}` object map; wptagent → `[{ts, bytes}]` array. Normalize both.
- CPU / bandwidth data is polymorphic: array `[dict, max, avg]` or object `{data, max, count}`. Map to `[time, scaledPct]` and preserve `arr.max`.
- LCP / FCP may live only in nested `chromeUserTiming` arrays — inspect there before defaulting to -1.

### Wptagent (ZIP)
- Digest via `BrowserStorage` → OPFS + Web Locks (no SharedWorkers). Don't leak OPFS locks across reloads.
- Only `testinfo.json[.gz]` and `[run]_devtools_requests.json.gz` are unboxed on parse. Other entries are listed in `output.log._zipFiles` for on-demand extraction.
- Response bodies: each request references `body_file` (`001-<id>-body.txt`) inside `[run]_bodies.zip` (and `[run]_Cached_bodies.zip` for repeat). Extract to temp storage via `ZipReader`, base64-encode, set `response.content.{text,encoding:'base64'}`. Destroy temp storage immediately after extraction.
- Main thread flame chart: parse `[run][_Cached]_timeline_cpu.json[.gz]` per run/cached combo. Only the primary `main_thread` slice arrays are kept (background / GC helper threads are dropped — theverge ships 20+ threads × ~8700 slices × ~100 categories; carrying them all inflates the HAR by ~15 MB for no renderer benefit). Raw Chrome event names are folded into the canonical five WPT categories (`ParseHTML`, `Layout`, `Paint`, `EvaluateScript`, `other`) via `MAIN_THREAD_CATEGORY_MAP` in `src/core/mainthread-categories.js` (shared with `chrome-trace.js`) — mirror additions to `Sample/Implementations/webpagetest/www/waterfall.inc#L437-L491` when new event types show up. Output: `page._mainThreadSlices = {slice_usecs, total_usecs, slices}` where each slice value is integer microseconds within the window (fraction = value / slice_usecs). Renderer in `canvas.js` walks each pixel of the data area, sums usecs per category across the slices that fall under that pixel, and stacks colored bars bottom-up in fixed order `ParseHTML → Layout → Paint → EvaluateScript → other`.
- CPU / BW utilization: parse `[run][_Cached]_progress.csv[.gz]` (columns `Offset Time (ms), Bandwidth In (bps), CPU Utilization (%), Memory`) and hand the raw dict to `formatWptUtilization` → `page._utilization`. Match pages by `_run`/`_cached` — `processWPTView` mints ids like `page_${run}_${cached}_1`, so string-concatenating `page_${run}_${cached}` silently misses everything (historical bug: graphs flat-zero on every wptagent zip import).
- JS execution overlays: parse `[run][_Cached]_script_timing.json[.gz]`. Shape is `{main_thread: "<tid>", "<tid>": {url: {eventName: [[start_ms, end_ms], ...]}}}`. Only the thread id in `main_thread` is consumed (off-thread parse/compile blocks are intentionally dropped to match the reference renderer). Allowlisted event names are flattened into `entry._js_timing = [[start, end], ...]` and attached by `_full_url` equality, first match wins (mirrors the `$used` de-dup in `waterfall.inc#L2004-L2011`). Allowlist mirrors `$script_events` at `waterfall.inc#L1976-L1993` — `SCRIPT_TIMING_EVENTS` lives in `src/core/mainthread-categories.js` (shared with `chrome-trace.js`); keep it in sync.

### Netlog
- QUIC multiplexing: trap `HTTP_STREAM_REQUEST_BOUND_TO_QUIC_SESSION` and map `source_dependency` to `quic_session`. `quicSession.stream` matching fails — Chromium leaves `stream_id` undefined on `URL_REQUEST`.
- Response bodies: collect base64 chunks from `URL_REQUEST_JOB_FILTERED_BYTES_READ` → `request.encoded_body`; emit `response.content.text` with `encoding:'base64'`.

### CDP
- Aborted requests with no `responseReceived` → fault out with `errorCode = 12999` so renderer doesn't draw ghost bars.

### Tcpdump
- Binary pipeline on `Uint8Array` + `DataView` only. No Node `Buffer`.
- **PCAPNG:** sniffs magics, extracts Enhanced Packet Blocks. Timestamp precision assumes µs; full Interface Description Block tracking pending real `.pcapng` fixtures.
- Raw parser decodes Ethernet / IPv4 / IPv6 / TCP / UDP.
- **QUIC:** unwraps 1-RTT AEAD, tracks all RFC-9000 frame types. Header protection via `AES-CBC` with zero IV (WebCrypto rejects raw ECB). Port 443 carries STUN/TURN: drop datagrams when `(firstByte & 0x40) === 0`. After `MAX_CONSECUTIVE_FAILURES = 5` AEAD failures (while `forwardKeys === null`), bail out of the connection — prevents brute-force CID-length loops on non-QUIC UDP floods.
- **QPACK** (`src/inputs/utilities/tcpdump/qpack-decoder.js`): RFC 9204 prefixes (not HPACK constants). Stateful encoder-dynamic-table instructions per direction. Shares Huffman tree with HPACK. HTTP/3 request headers often missing from 0-RTT; still emit HAR entry from server response.
- **HPACK** (`src/inputs/utilities/tcpdump/hpack-decoder.js`): custom zero-dep RFC 7541 impl, `decode(Uint8Array) → [{name,value}]`, stateful per direction.
- **TLS/TCP reconstruction:** interleave client + server `contiguousChunks` chronologically (order matters for `ServerHello` random / key derivation).
- **HTTP/1 parser:** header search has 256KB `MAX_HEADER_SCAN` cap — returns `null` on overrun, prevents O(n²) rescans when encrypted flows are mis-sniffed as HTTP/1. Skip zero-length chunks at top of `parse()` and `_readLengthBody()` — TLS empty records (alerts, CCS, close_notify) otherwise infinite-loop.
- **Priority:** HTTP/2 from HEADERS flag 0x20 or standalone PRIORITY frames; `weight ≥ 256/220/183/147` → Highest/High/Medium/Low/Lowest (matches `netlog.js`). HTTP/3 from `priority` header `u=N`: 0-1 Highest, 2 High, 3 Medium, 4-5 Low, 6-7 Lowest.
- **Bandwidth:** 100ms sliding window over server→client packets → `_bwDown` Kbps on page.
- **Chunks:** populate `_chunks: [{ts, bytes, inflated?}]` from HTTP/1 body segments, H/2 DATA, H/3 DATA frames.
- **Bytes out:** estimate from request line + header sizes.
- **Uncompressed size:** track `_objectSizeUncompressed` in `extractAndStoreBody()` when decompression output differs from wire.
- **Event-loop yielding:** `yieldToEventLoop = () => new Promise(r => setTimeout(r, 0))` at module scope. Yield at phase transitions and every 5 TLS connections / 10 TCP decodings. Prevents "script taking too long" dialogs.
- **Base64 encoding:** chunk to 8KB slices with `String.fromCharCode.apply(null, subarray)`, join once. Per-char concat is O(n²).

## Content decompression (`src/core/decompress.js`)

- `decompressBody(data, encoding)` handles `gzip`, `x-gzip`, `deflate`, `br`, `zstd`. Native `DecompressionStream` when available (constructor-probe cached per algorithm); fallbacks: `brotli/decompress` (pure JS, dict is ~69KB) and `fzstd` (~8KB). Dynamic imports so bundlers code-split.
- Unknown encodings pass through as raw wire bytes.
- Orchestrator and tcpdump CLI both wire `options.deps.decompressBody` and `options.deps.decompressBodyPerChunk`.

## Per-chunk `inflated`

`_chunks[].inflated` = decoded bytes contributed by that wire chunk. Sum == `_objectSizeUncompressed`. Lets consumers slice the base64 body by delivery time.

- **Principle:** missing is better than wrong. Never distribute proportionally. Omit `inflated` when genuine per-chunk attribution isn't available. Absent → consumers treat as equal to `bytes`.
- **Per source:**
  - `netlog` / `chrome-trace`: set directly from `URL_REQUEST_JOB_FILTERED_BYTES_READ` (Chrome attaches inflated to most recent wire chunk as filtered bytes emit).
  - `wpt-json` / `wptagent`: pre-computed upstream via CDP; flows through the generic `_`-prefix mapping.
  - `cdp`: from `Network.dataReceived` where `dataLength !== encodedDataLength`. Omitted when equal.
  - `tcpdump`: streaming decompression via `decompressBodyPerChunk`. Each wire chunk written individually; output byte delta recorded. Many chunks emit 0 bytes (decoder buffers) then one bursts — that's correct. When streaming isn't available (brotli pure-JS fallback), returns `null` → caller still decompresses via `decompressBody` one-shot for body bytes but omits `inflated`.
- **Streaming helper internals:** `DecompressionStream` path uses parallel read-drain: background reader loop accumulates into a counter; after each `writer.write(chunk)`, one `await new Promise(r => setTimeout(r, 0))` lets pending microtasks drain before sampling the counter delta. `fzstd` path uses synchronous `ondata` inside each `push(chunk, isLast)` — no yield needed.
- Preserved through `har-converter.js` (`_chunks: entry._chunks || []`) and `waterfall-tools.js#getHar()` generic `_`-prefix property copy.

## Renderer (`src/renderer/`)

- Canvas. `window.devicePixelRatio`: `canvas.width *= dpr`, `ctx.scale(dpr, dpr)`. Logical coordinates stay CSS px.
- **Layer order:** row-background bands → time grid → request blocks → metric lines (Start Render, LCP) → chunks overlay → labels.
- **PHP→HTML5 rect boundaries:** GD was inclusive (`x1..x2` covers `x2-x1+1` px). `fillRect(x,y,w,h)` uses raw delta. Always `width = (x2 - x1) + 1` for 2px-minimum visibility on same-timestamp events (`_domContentLoadedEventStart` == `...End`).
- **Path poisoning:** any `NaN`/`Infinity` inside a `beginPath` block drops the whole path silently. Guard every coordinate with `isFinite(x) && isFinite(y)`.
- **Fill style:** set `ctx.fillStyle` / `strokeStyle` **immediately before** each `fillRect` / `stroke`. Lingering state silently renders black/white.
- **Row backgrounds:** redirects (300-399 except 304) → opaque yellow. Errors (≥400 or 0) → opaque red. 100% opacity before request blocks.
- **TTFB gradient:** request row base fills from start to `downloadEnd`. `_chunks` overlay the TTFB base opaquely with byte progression.
- **Connection phases** (Wait, DNS, Connect, SSL) use fixed WPT colors, not content-type `baseColor`.
- **Solid download fallback:** when `maxBw === 0`, draw one solid block from TTFB end → request end (avoids hundreds of 1px slivers).
- **Cross-origin:** compare entry URL origin to base document URL (`rawEntries[0]._documentURL`). Mismatch → label text in blue `#0000ff`.
- **Render blocking:** `_renderBlocking === 'blocking'` → 14px `#ff9900` circle, 1.5px white-stroke X. Drawn from canvas primitives (no PNG asset).
- **Label layering:** metric labels paint opaque background (`#ffffff` or `#f0f0f0` matching row stripe) behind text to prevent grid bleed.
- **Legend:** connection phases = solid uniform bars. MIME types = 20px split bars, left half `scaleRgb(color, 0.65)` TTFB tint, right half primary download color.
- **Utilization graphs (CPU, BW):** stair-stepped. Value = window-aggregated, not instantaneous — draw horizontal to new-ts-at-old-value, then vertical to new value. Diagonal interpolation is wrong.
- **Bandwidth normalization:** rolling deficit carries instantaneous overflow forward into subsequent buckets (dark green, WPT standard).
- **Connection View** (`options.connectionView`): suppress per-request TTFB backgrounds, JS-execution highlights, per-request timing labels.
- **Thumbnail view** (`options.thumbnailView`, `options.thumbMaxReqs`): truncates at 100 by default with torn-edge; 0 disables truncation.
- **Absolute timings path:** when entries carry `_dns_start`, `_load_start`, `_ttfb_end`, `_download_start`, `layout.js` bypasses conventional arithmetic `timings[]` chaining via `hasAbsoluteTimings` — preserves parallel phases (e.g. DNS during queue block).
- **Queue band:** `row.colors.wait` must end at the earliest absolute start of any active network phase — prevents wait bars spanning uninstrumented preconnect gaps.
- **Connection phase bounds:** map `sslEnd`/`connectEnd` independently; never interpolate `sslEnd → ttfbStart` as a fallback.
- **Multi-page filter:** filter `log.entries` by `pageObj.id` before layout.
- **Callbacks:** `options.onHover(req)`, `options.onClick(req)`.
- **Resize:** viewers persist parsed `ExtendedHAR` globally, debounce `window.resize`, recompute via `Layout.calculateRows` non-destructively.
- `options.labelsCanvas` + `options.overlapLabels` split labels from data into a separate canvas. Pinch-to-zoom updates `options.startTime`/`endTime` via `updateOptions()` — don't regenerate full layout.
- `WaterfallTools.getDefaultOptions()` returns canonical boolean/filter dict: `{ connectionView, thumbnailView, thumbMaxReqs, showCpu, showBw, showMainthread, showLongtasks, showMissing, showLabels, showChunks, showJsTiming, showWait, showLegend, reqFilter, startTime, endTime }`. Keep in sync when adding controls.

## Viewer (`src/viewer/`)

- Landing page + URL entry bar at `index.html`. `?src=<url>` triggers remote fetch. Auto-transforms WPT GUI URLs (`/result/.../`, `/results.php?test=...`) → `export.php?bodies=1&test=...`.
- Whenever supported formats or capabilities change, update the landing page copy and feature list.
- **History (IndexedDB `WaterfallHistoryDB`):** tracks URL-based test loads via `src/viewer/history.js#saveToHistory`. No cookies / localStorage.
- **Browser History API:** `pushState` / `popstate` for tile-view ↔ canvas navigation. Full back to empty state → `resetViewerState()` clears drop zone AND calls `waterfallTool.destroy()` (prevents OOM on next load).
- **Reset on new file drop:** remove `.req-tab` entries, revoke `activeBlobUrls`, clear iframe `.src` (Lighthouse/Trace), call `waterfallTool.destroy()`.
- **Drag overlay:** `dragCounter` incremented on `dragenter`, decremented on `dragleave`. Only hide when `dragCounter === 0` — avoids flicker over child `<canvas>`.
- **Expand/collapse:** inline SVG chevrons only, no emoji/text glyphs.
  - Open (up): `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`
  - Closed (down): swap `points="6 9 12 15 18 9"`. Mutate via `.setAttribute('points', ...)`.
- **Tabs:** drag-and-drop reorder; overflow scrollbars via `MutationObserver` + resize loops.
- **Progress bar:** `#progress-container` / `#progress-bar` driven by `onProgress(phase, percent)` → `updateProgress()`.
- **Body rendering by MIME:**
  - text (`text/*`, json, javascript, xml, css, svg) → decode base64 → UTF-8 → syntax-highlighted `<pre>` with copy button.
  - image → `<img>` with `data:` URI.
  - other binary → byte-size estimate.
  - fallback: URL for images when body absent.
  - `body` field excluded from Raw Details JSON.
- **Chunked HTML body viewer** (`buildChunkedHtmlBody`): for HTML MIME with `_chunks[].ts` and base64 body, renders a hex-viewer-style two-col table, one row per wire chunk.
  - Slice by `inflated` when present; fall back to `bytes`. Leftover from undercounts absorbed into final chunk; overflow clamped from tail.
  - UTF-8 boundary safe via `TextDecoder('utf-8').decode(slice, { stream: true })` on raw `Uint8Array` slices.
  - Time label: `[absTime] ms ([±deltaTime] ms)`. First chunk delta = `ts - time_start` (TTFB). Subsequent = inter-arrival. All normalized via `toWaterfallMs(ts)` — mirrors `canvas.js#L883` but uses the page anchor (`pageData.startedDateTime` epoch, else earliest `time_start` across entries) as the epoch-vs-relative discriminator. **Don't** use the `> 1e12` magic constant (breaks for small-epoch parsers — see historical netlog 1970-07-15 bug).
  - Size label: `<inflated> · <wire> wire` when different; one value when equal.
  - Row `min-height: 56px`. Alternating `#fff`/`#f6f7f9` with `#e6e6e6` separators. Body cell `flex: 1 1 auto; min-width: 0; max-height: none; overflow: visible` — no per-chunk scroll, outer tab handles it.
  - Returns `null` on decode failure / empty chunks / missing timestamps → caller falls back to `<pre>`.
- **HAR export sort:** `getHar()` sorts by `_load_start` when available, not `time_start`. Only populate fallback `entry._load_start` when `entry._load_start === undefined` — preserve parser-provided values.

## Embedded viewers

### NetLog viewer
- Self-hosted uncompressed build at `src/viewer/public/netlog-viewer/index.html` (served same-origin to bypass CORS — the legacy Chrome build uses `const`-scoped utilities unreachable across origins).
- Inject logs: `DecompressionStream('gzip')` on `_netlog.txt.gz`, monkey-patch `window.ImportView.getInstance().onLoadLogFile()` to intercept `FileReader` completion, set `location.hash = '#events'` on terminate to skip empty-UI flash.

### Chrome DevTools frontend
- Shipped via the **`@chrome-devtools/index`** npm package (MIT, prebuilt, maintained by `iam-medvedev`). The upstream Google `chrome-devtools-frontend` package is source-only (needs `vpython3`/`gn`/`ninja`) and is deliberately not used.
- **Keep it fresh** — bump the dependency on every project work session: `npm install --save @chrome-devtools/index@latest`. Commit `package.json` + `package-lock.json` with the version bump.
- Version flows through automatically: `scripts/build.js` reads `node_modules/@chrome-devtools/index/package.json` at build time, copies the bundle to `dist/browser/devtools-<version>/`, and injects `<meta name="waterfall-devtools-path" content="./devtools-<version>/">` into `dist/browser/index.html`. Never hard-code the version anywhere — the build plumbing derives it in one place.
- `vite.dev.config.js` does the same thing for dev (`npm run dev:viewer`): reads the same `package.json`, serves `/devtools-<version>/*` from `node_modules/@chrome-devtools/index/` via middleware, and `transformIndexHtml` populates the meta tag. Source HTML carries an empty `content=""` placeholder that both paths overwrite.
- The 79 MB DevTools bundle is **excluded from Brotli pre-compression** (`compressDirectory` skips any `dist/browser/devtools-*` dir). Pre-compressing already-optimized third-party assets at level 11 would dominate the build.
- Viewer (`src/viewer/viewer.js`): `getDevtoolsPath()` reads the meta tag; `loadDevtools(traceBuffer)` sets `iframe.src = path + 'index.html?panel=timeline'` (the `panel=<id>` query param is honored by the DevTools entry as the default tab — selecting it lazily instantiates the TimelinePanel, which registers itself on `self.UI.panels.timeline` via `self.UI.panels[panelName]=this`). The **DevTools tab is gated on the same `getPageResource(pageId, 'trace')` availability signal that enables the Perfetto tab** (if a page has a trace, both tabs are offered). The Perfetto tab was renamed from "Trace".
- **Loading a trace:** after the iframe load event, poll `iframe.contentWindow.UI?.panels?.timeline?.loadFromFile` until it resolves (panel is lazily imported), then call `panel.loadFromFile(new cw.File([buffer], 'trace.json[.gz]', {type: 'application/gzip' | 'application/json'}))`. `TimelinePanel.loadFromFile` routes through `Common.Gzip.fileToString` which decompresses when `file.type` ends with `gzip`, then `JSON.parse` + `TimelineLoader.loadFromParsedJsonFile` into the flame chart. Use the iframe's own `File` constructor (`cw.File`) to avoid cross-realm prototype mismatches.
- **Binary Perfetto protobuf buffers aren't supported yet** — `loadFromFile` expects Chrome-trace JSON. `sniffTraceFormat()` in `viewer.js` detects gzip (`1f 8b 08`) vs JSON (`{` / `[`, optionally BOM-prefixed) vs binary; binary buffers get a "use the Perfetto tab" message in the overlay instead of a silent malformed-data error. Follow-up work: run the buffer through `src/inputs/utilities/perfetto/` to transcode to Chrome-trace JSON before handing to DevTools.
- **Do not rely on the `?traceURL=` / `?loadTimelineFromURL=` query params** — those hit a separate "rehydration" code path (`startHydration`) that simulates a full debugger session, not the in-panel trace viewer.

### Perfetto (`src/inputs/utilities/perfetto/`)
- Pure JS TLV varint protobuf decoder (no `traceconv`, no WASM, no SQLite).
- `interned_data` (Name/Category/Event IIDs) scoped by `trusted_packet_sequence_id` — mirrors C++ sequence namespacing, prevents ID collision bleed.
- Per-sequence monotonic offsets: track `timestamp_delta_us` and `timestamp_absolute_us`. For netlog arrays embedded as nested JSON (`args.params.source_start_time`), bypass delta state and re-anchor to the monotonic base.
- Modern Chromium wraps dictionaries in `V8.SnapshotDecompress` / `preLCP`-like contexts — detect and correct back to `devtools.timeline` shape.
- **Original buffer bypass:** `waterfallTool.getPageResource(pageId, 'trace')` returns the raw `Uint8Array` for `.perfetto` inputs, routed straight into the `https://ui.perfetto.dev` iframe.
- **Double_value extraction:** detailed timings (`requestTime`, `dnsStart`, `connectStart`) live in `DebugAnnotation.double_value` (field 5, wire 1). Decode with `new DataView(buf, off, 8).getFloat64(0, true)`. Missing → silent `null` / `0` / `-1` downstream.
- **Netlog events in Perfetto traces:** override `data.time` strings (OS uptime values) with `trace_event.ts` bounds. Missing override → subtracting ~`-4465` µs against ~`10^10` ticks shatters bounds by ~118 days.
- Headers from `devtools.timeline` are objects — normalize to `["Name: Value"]` string arrays before mapping into `netlog.js`.
- Don't require `req.end` or `req.request_headers` when attaching netlog state to timeline synthesis.

## getPageResource / OPFS

- `waterfallTool.getPageResource(pageId, resourceType)` — browser returns `{url, mimeType}` blob; Node returns `{buffer}`.
- Supports nested netlog queries → `*_netlog.json.gz` or `*_netlog.txt.gz`.
- **Requires** `_run` and `_cached` on the HAR page object — without them, `2_Cached_screen.jpg` lookups fail.
- Lighthouse `.html.gz` extracted via `DecompressionStream('gzip')` for iframe rendering.
- Tile grids: use `flex-wrap: wrap; width: fit-content` — `span 2` auto-fill stretches tiles incorrectly otherwise.

## Outputs (`src/outputs/`)

- `simple-json`: 1D array, flattens `request`/`response` into top-level props (`url`, `method`, `status`, `ttfb_ms`).

## Cloudflare Worker (`cloudflare-worker/worker.js`)

Single-file, zero-binding Worker providing CORS-safe fetch proxy for viewer URL imports.

- **Scope:** only `/fetch`. All other paths → `fetch(request)` passthrough.
- **Contract:** `GET /fetch?url=<encoded http(s) URL>`. Streams upstream body byte-for-byte with `Access-Control-Allow-Origin: *`. Diagnostic `X-Waterfall-Tools-Format` header. No `HEAD` (can't sniff without body).
- **Format sniff:** reads first 64KB, runs `identifyFormatFromBuffer` — MUST mirror `src/inputs/orchestrator.js`. **When a new input format is added to the orchestrator, `cloudflare-worker/worker.js` MUST be updated in lockstep** (Worker is intentionally self-contained for paste-to-dashboard deploys — no build-time imports). Unknown formats → `415 unsupported_format`.
- **Stream architecture:** reads first 64KB into buffered chunks for sniffing, then constructs a new `ReadableStream` that re-emits the buffered chunks (preserving backpressure) before forwarding `reader.read()` output unchanged. No reassembly. No transformation. `Content-Encoding` passed through.
- **Non-anonymizing:** appends `X-Forwarded-For`, `X-Real-IP`, RFC-7239 `Forwarded` (quoted for IPv6), `Via: 1.1 waterfall-tools-proxy`.
- **SSRF guard:** `isPrivateHost` blocks loopback, RFC 1918, link-local (169.254/16, fe80::/10), CGNAT (100.64/10), ULA (fc00::/7), `localhost` / `.local` / `.internal`, IPv4-mapped-IPv6 (`::ffff:127.0.0.1`). Hostname-based only — doesn't resolve DNS. Note limitation when deploying alongside private services.
- **Rate limit:** in-memory per-IP `Map<string, {count, firstFailureMs}>` at module scope. `RATE_LIMIT_MAX_FAILURES = 10` within `RATE_LIMIT_WINDOW_SECONDS = 600`. Increments only on failed requests (upstream error, non-2xx, unsupported format, SSRF reject, malformed URL). Successes don't count or reset. Per-isolate — sufficient for the threat model (Cloudflare keeps isolates warm, same colo = same isolate for repeat requests).
- **Fail-closed cap:** `RATE_LIMIT_MAP_CAP = 10000`. When full of still-active-window entries, **refuses to evict** and returns `429` for all callers until the oldest ages out. Deliberately chooses honest-path availability over overflow-abuse availability. Ensures rate limiter cannot fail-open.
- **Client IP:** prefer `CF-Connecting-IP`, fallback to leftmost `X-Forwarded-For` (for `wrangler dev`).
- **Deploy:** `wrangler deploy cloudflare-worker/worker.js` (wrangler.toml provided) or paste into dashboard "Module Worker" editor. No KV / D1 / DO / Rate Limiting bindings.

## Code commentary

- Dense mathematical / coordinate-mapping logic (canvas rendering, binary parsing) must carry train-of-thought inline comments explaining *why* bounds fire in a specific order. Rollup/Vite strips comments in production — no bloat cost.
- Don't explain what readable code already shows. Only explain why.
