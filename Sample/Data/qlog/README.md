# qlog samples

qlog is the IETF structured logging format for QUIC/HTTP-3
([main schema](https://quicwg.org/qlog/draft-ietf-quic-qlog-main-schema.html),
[QUIC events](https://quicwg.org/qlog/draft-ietf-quic-qlog-quic-events.html),
[HTTP/3 events](https://quicwg.org/qlog/draft-ietf-quic-qlog-h3-events.html)).
One qlog file describes one QUIC connection. Two serializations exist:
plain JSON (`.qlog`, top-level `{qlog_version, traces: [...]}`) and
JSON-SEQ / RFC 7464 (`.sqlog`, one JSON record per `0x1E` separator).

All samples here are qlog draft version 0.3 with the pre-rename event
namespaces (`transport:*`, `http:*`, `recovery:*`, `connectivity:*`,
`security:*`). Current spec drafts rename `transport:` → `quic:` and
`http:` → `http3:` — importer must accept both.

## `aioquic/` — full quic+http3 events, plain JSON

Captured 2026-07-04 by replaying every request from
`Sample/Data/HARs/WebPageTest/www.google.com.har.gz` over HTTP/3 against
live Google servers, preserving the original per-request start offsets
(same serial/parallel stream mix as the real page load, one QUIC
connection per host = 5 files):

| file | requests | notes |
|---|---|---|
| `www.google.com.qlog.gz` | 29 | main connection, heavy multiplexing, 1 MB+ response bodies |
| `fonts.gstatic.com.qlog.gz` | 3 | woff2 fonts, parallel |
| `www.gstatic.com.qlog.gz` | 3 | JS/CSS/favicon |
| `ogads-pa.clients6.google.com.qlog.gz` | 2 | OPTIONS preflight + POST (400 — replay has no RPC body) |
| `play.google.com.qlog.gz` | 2 | OPTIONS preflight + POST (400 — replay has no RPC body) |

aioquic logs `http:frame_created` / `http:frame_parsed` with decoded
plaintext headers (`:method`, `:path`, `:status`, `content-type`, ...),
so full waterfall attribution is possible. Event `time` values are
**absolute epoch milliseconds** (no `reference_time` in `common_fields`).

Regenerate with `Sample/Implementations/qlog/replay_har_qlog.py`:

```
pip install aioquic wsproto
curl -O https://raw.githubusercontent.com/aiortc/aioquic/main/examples/http3_client.py
python3 replay_har_qlog.py www.google.com.har.gz <output-dir>
```

## `curl/` — transport-only events, JSON-SEQ

Captured 2026-07-04 with an HTTP/3-enabled curl 8.21.0 (ngtcp2 backend,
static build from https://github.com/stunnel/static-curl):

```
QLOGDIR=<dir> curl --http3-only [--parallel] \
  https://cloudflare-quic.com/ https://cloudflare-quic.com/robots.txt ...
```

- `cloudflare-quic.com-serial.sqlog.gz` — 3 requests issued sequentially
  on one connection (curl's default for multiple URLs).
- `cloudflare-quic.com-parallel.sqlog.gz` — 4 requests with `--parallel`,
  all sent at t≈18 ms and multiplexed.

ngtcp2's qlog emits **no `http:` namespace events** — request/response
headers stay QPACK-encoded inside opaque STREAM frame bytes. Streams are
visible only as `transport:packet_sent`/`packet_received` STREAM frames
(stream id, offset, length, fin), so entries parse without URL, method,
or status (degraded mode). Times are **relative** with
`common_fields.reference_time: 0` — i.e. no wall-clock anchor at all;
the importer must synthesize an epoch.
