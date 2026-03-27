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
- `_chunks` (Array): Streaming chunks representations.
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
Global WebPageTest page-level timings and context records (such as performance milestones and audit data) are added directly onto the `.log.pages[0]` object with a leading underscore:

### Dictionary & Array Fields
- **Process & CPU:** `_cpuTimes`, `_cpuTimesDoc`, `_v8Stats`, `_execution_contexts`, `_utilization`
- **Environment & App:** `_detected`, `_detected_apps`, `_detected_technologies`, `_webdx_features`, `_viewport`, `_aurora`, `_cms`, `_pwa`
- **Network:** `_origin_dns`, `_cookies`, `_domains`, `_breakdown`, `_requests`, `_pages`
- **Audits & SEO:** `_audit_issues`, `_axe`, `_parsed_css`, `_performance`, `_privacy-sandbox`, `_robots_meta`, `_valid-head`, `_ecommerce`, `_fugu-apis`, `_generated-content`, `_origin-trials`
- **Timings & Visuals:** `_userTimes`, `_userTimingMeasures`, `_interactivePeriods`, `_longTasks`, `_largestPaints`, `_chromeUserTiming`, `_blinkFeatureFirstUsed`, `_consoleLog`, `_usertiming`, `_thumbnails`, `_images`, `_videoFrames`

### Scalar Fields (Partial List)
- **Loading metrics:** `_loadTime`, `_docTime`, `_fullyLoaded`, `_TTFB`, `_SpeedIndex`, `_LastInteractive`, `_TotalBlockingTime`, `_maxFID`
- **Resource totals:** `_bytesOut`, `_bytesOutDoc`, `_bytesIn`, `_bytesInDoc`, `_requestsFull`, `_requestsDoc`
- **Paint timings:** `_firstContentfulPaint`, `_firstPaint`, `_firstImagePaint`, `_firstMeaningfulPaint`, `_LastInteractive`
- **Visual Completion milestones:** `_lastVisualChange`, `_render`, `_visualComplete85`, `_visualComplete90`, `_visualComplete95`, `_visualComplete99`, `_visualComplete`
- **Environment config:** `_browser_name`, `_browser_version`, `_osPlatform`, `_osVersion`, `_testUrl`, `_testID`
