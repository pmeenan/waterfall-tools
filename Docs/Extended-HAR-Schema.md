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
Every request object in the `.log.entries` array maps tightly to standard HAR values (request headers, timing, sizes). However, to fully represent exact waterfall characteristics without mutating native HAR structures, we embed custom fields onto each `entry` node:

### Network and Identifying Fields
- `_id`, `_request_id` (string): Identifiers for tracing request references mappings.
- `_full_url`, `_url`, `_host` (string): Resolution URLs.
- `_ip_addr` (string): Target server IP.
- `_protocol` (string): Negotiated protocol (h2, http/1.1, quic).
- `_is_secure` (number/boolean): Whether connection is TLS encrypted.
- `_method` (string): Request method.
- `_responseCode` (number): Equivalent to response.status.
- `_socket`, `_socket_group` (number/string): Connection pooling identifier.
- `_request_type`, `_type` (string/number): High-level resource classification (Script, Image, Fetch, Document).

### Timing Characteristics (Overrides or supplements standard `time` & `timings`)
- `_load_start`, `_load_end`, `_load_ms` (number): Absolute loading offsets/durations relative to test start.
- `_dns_start`, `_dns_end`, `_connect_start`, `_connect_end`, `_ssl_start`, `_ssl_end`: Granular phase timestamps.
- `_ttfb_ms`, `_download_ms`: Breakdown of time to first byte versus body streaming duration.

### Sizing and Perf Characteristics
- `_bytesIn`, `_objectSize`, `_objectSizeUncompressed` (number): Sizing of the wire stream.
- `_priority`, `_initial_priority` (string): Render loading priority (Low, High, Highest, etc).
- `_renderBlocking` (boolean): Whether resource strictly blocks DOM parsing.
- `_is_base_page`, `_final_base_page` (boolean): Flags representing the root navigational HTML elements.

### Initiator Information
- `_initiator`, `_initiator_type`, `_initiator_line`, `_initiator_column`, `_initiator_function` (string/number): Information identifying which script or DOM operation triggered the network call originally.

## Page Sub-object Extensions
Global WebPageTest page-level timings like First Contentful Paint, Time to Interactive, etc. are added on the `.log.pages[0]` object natively as custom keys.

- `_firstContentfulPaint` (number)
- `_firstPaint` (number)
- `_firstMeaningfulPaint` (number)
- `_domComplete` (number)
- `_fullyLoaded` (number)
- `_visualComplete` (number)
