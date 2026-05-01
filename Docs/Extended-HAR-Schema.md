# Extended HAR Schema

Waterfall Tools relies on standard HAR 1.2 as the foundational schema, extended to include performance, rendering, and interaction metrics traditionally output by tools like WebPageTest.

## Generator Identity
Following standard HAR, the generated HAR MUST include a `creator` object:
```json
"creator": {
  "name": "waterfall-tools",
  "version": "1.0.x"
}
```

## Entry Extensions (`_` prefixed)
Every request object in the `.log.entries` array maps tightly to standard HAR values (request headers, timing, sizes). We augment this with robust request-level metrics mapping from tools like WebPageTest:

### Dictionary & Array Fields
- `_chunks` (Array): Per-chunk response body delivery records. Each entry: `{ ts, bytes, inflated? }`
  where `ts` is the absolute millisecond timestamp, `bytes` is the wire-byte count for that delivery,
  and `inflated` (optional) is the decoded/uncompressed byte count contributed by this chunk when the
  body was content-encoded (gzip/br/zstd/deflate). When the response is uncompressed, `inflated` is
  omitted (implicitly equal to `bytes`). The sum of `inflated` across all chunks equals the total
  decoded body size. Sources that emit `inflated`:
  - **netlog / chrome-trace**: populated directly from `URL_REQUEST_JOB_FILTERED_BYTES_READ` events.
  - **WPT JSON / wptagent**: passed through from Chrome DevTools Protocol data in the upstream capture.
  - **CDP**: populated from `Network.dataReceived.dataLength` when it differs from `encodedDataLength`.
  - **tcpdump**: populated via streaming decompression — each wire chunk is fed individually into
    a `DecompressionStream` (gzip/deflate/brotli) or `fzstd.Decompress` stream (zstd), and the
    exact number of decompressed bytes emitted in response to that write is recorded as `inflated`.
    When streaming is not available for the encoding (e.g. brotli without native
    `DecompressionStream` support forcing the non-streaming pure-JS fallback), `inflated` is
    omitted entirely — we never report approximate per-chunk sizes.
- `_headers` (Object): Parsed request/response headers block.
- `_dns_info`, `_dns_details` (Object): Detailed DNS resolution steps and host mappings.
- `_cpuTimes`, `_js_timing` (Object): Script execution and CPU parsing metrics tied to specific payloads.
- **Extended Resources:** `_certificates`, `_font_details`, `_image_details`, `_securityDetails`, `_tls_cipher_suite`

### Scalar Fields (Partial List)
- **Identifiers:** `_id`, `_request_id`, `_raw_id`, `_netlog_id`, `_body_id`, `_body_file`, `_connectionId`, `_http2_stream_id`
- **Network Fields:** `_is_secure`, `_method`, `_host`, `_url`, `_ip_addr`, `_frame_id`, `_socket`, `_socket_group`, `_server_port`, `_protocol`, `_request_type`, `_type`, `_responseCode`, `_resourceType`, `_securityState`, `_fromCache`
- **Timings:** `_load_ms`, `_ttfb_ms`, `_load_start`, `_load_end`, `_dns_start`, `_dns_end`, `_connect_start`, `_connect_end`, `_ssl_start`, `_ssl_end`, `_download_start`, `_download_end`, `_all_start`, `_all_end`
- **Sizing:** `_bytesIn`, `_bytesOut`, `_objectSize`, `_objectSizeUncompressed`
- **Initiator:** `_initiator`, `_initiator_type`, `_initiator_line`, `_initiator_column`, `_initiator_function`, `_isLinkPreload`, `_preloadUnused`, `_renderBlocking`
- **WebPageTest Scores:** `_score_cache`, `_score_cdn`, `_score_gzip`, `_score_keep-alive`, `_score_minify`, `_score_combine`, `_score_compress`, `_score_progressive_jpeg`
- **Response Ext:** `_error`, `_fetchedViaServiceWorker`, `_transferSize`
- **Timing Ext:** `_blocked_queueing`, `_workerFetchStart`, `_workerReady`, `_workerRespondWithSettled`, `_workerStart`

## Page Sub-object Extensions
Global WebPageTest page-level timings and context records (such as performance milestones and audit data) are added directly onto the `.log.pages[0]` object with a leading underscore.

> **Producer interop note.** chrome-har and tools that build on it (Browsertime, sitespeed.io) nest the same kind of timing extensions inside `pages[].pageTimings` rather than the page root. The HAR 1.2 spec only mandates the `_` prefix — both placements are valid. The HAR importer (`src/inputs/har.js#liftPageTimingsExtensions`) normalizes the `pageTimings` shape onto the canonical page-root names listed below, so the renderer always reads from a single layout. Originals stay under `pageTimings` for HAR-faithful round-trips. Producers that already write to the page root remain authoritative — page-root values win on conflict.

### Dictionary & Array Fields
- **Process & CPU:** `_cpuTimes`, `_cpuTimesDoc`, `_v8Stats`, `_execution_contexts`, `_utilization`
- **Environment & App:** `_detected`, `_detected_apps`, `_detected_technologies`, `_webdx_features`, `_viewport`, `_aurora`, `_cms`, `_pwa`
- **Network:** `_origin_dns`, `_cookies`, `_domains`, `_breakdown`, `_requests`, `_pages`, `_unlinked_connections`, `_unlinked_dns_lookups`
- **Audits & SEO:** `_audit_issues`, `_axe`, `_parsed_css`, `_performance`, `_privacy-sandbox`, `_robots_meta`, `_valid-head`, `_ecommerce`, `_fugu-apis`, `_generated-content`, `_origin-trials`, `_lighthouse`
- **Timings & Visuals:** `_userTimes`, `_userTimingMeasures`, `_interactivePeriods`, `_largestPaints`, `_chromeUserTiming`, `_blinkFeatureFirstUsed`, `_consoleLog`, `_usertiming`, `_thumbnails`, `_images`, `_videoFrames`
- **Long tasks:** `_longTasks` (Array of `[msStart, msEnd]` pairs, page-relative) — main-thread tasks ≥ 50 ms. Tri-state presence contract consumed by the renderer: a **non-empty array** draws the red blocked spans over the green interactive band; an **empty array (`[]`)** means the parser ran long-task detection and found none — the renderer still draws the fully-green "interactive" band; a **missing field** means the parser doesn't instrument long tasks and the Long Tasks band row is suppressed entirely. Parsers that support long-task detection MUST emit `[]` rather than omitting the field when they see no qualifying tasks. Sources: **chrome-trace** / **perfetto** (merges `devtools.timeline` top-of-stack events ≥ 50 ms with `toplevel` RunTask durations ≥ 50 ms on main-thread candidates).
- **Main-thread flame chart:** `_mainThreadSlices` (Object): Per-slice histogram of primary main-thread CPU time folded into five canonical categories (`ParseHTML`, `Layout`, `Paint`, `EvaluateScript`, `other`) so the waterfall renderer can stack colored bars showing what the browser spent each time window doing. Only the primary thread is carried; background / GC helper threads are dropped.
  - `slice_usecs` (number): Fixed slice width in microseconds (wptagent emits 10000 = 10 ms slices).
  - `total_usecs` (number, optional): Sum of all slice widths — equals `slices[*].length * slice_usecs` when complete.
  - `slices` (Object): Keyed by category. Each value is an array of integer microseconds spent in that category during the Nth slice. Fraction-of-slice = `value / slice_usecs`.
  - Sources: **wptagent** (from `{run}_timeline_cpu.json.gz`, folded from Chrome's raw trace-event names via the WebPageTest category table in `Sample/Implementations/webpagetest/www/waterfall.inc#L437-L491`). Other formats (chrome-trace, perfetto) may populate this field in future releases.
- **External Data (Often Dropped):** `_almanac`, `_CrUX`

### Scalar Fields (Partial List)
- **Loading metrics:** `_loadTime`, `_docTime`, `_fullyLoaded`, `_TTFB`, `_SpeedIndex`, `_LastInteractive`, `_TotalBlockingTime`, `_maxFID`
- **Resource totals:** `_bytesOut`, `_bytesOutDoc`, `_bytesIn`, `_bytesInDoc`, `_requestsFull`, `_requestsDoc`
- **Paint timings:** `_firstContentfulPaint`, `_firstPaint`, `_firstImagePaint`, `_firstMeaningfulPaint`, `_LastInteractive`
- **Visual Completion milestones:** `_lastVisualChange`, `_render`, `_visualComplete85`, `_visualComplete90`, `_visualComplete95`, `_visualComplete99`, `_visualComplete`
- **Environment config:** `_browser_name`, `_browser_version`, `_osPlatform`, `_osVersion`, `_testUrl`, `_testID`
