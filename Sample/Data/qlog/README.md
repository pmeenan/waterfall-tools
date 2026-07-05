# qlog samples

qlog is the IETF structured logging format for QUIC/HTTP-3
([main schema](https://quicwg.org/qlog/draft-ietf-quic-qlog-main-schema.html),
[QUIC events](https://quicwg.org/qlog/draft-ietf-quic-qlog-quic-events.html),
[HTTP/3 events](https://quicwg.org/qlog/draft-ietf-quic-qlog-h3-events.html)).
One qlog file describes one QUIC connection. Two serializations exist:
plain JSON (`.qlog`, top-level `{qlog_version, traces: [...]}`) and
JSON-SEQ / RFC 7464 (`.sqlog`, one JSON record per `0x1E` separator).

The `aioquic/` and `curl/` samples are qlog draft version 0.3 with the
pre-rename event namespaces (`transport:*`, `http:*`, `recovery:*`,
`connectivity:*`, `security:*`); the `quiche/` samples are spec-final output
with the current `quic:` / `http3:` namespaces and no `qlog_version` field at
all — the importer must accept every generation (see each section for the
per-producer quirks).

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

## `quiche/` — spec-final qlog, both vantage points, JSON-SEQ

Captured 2026-07-05 by running Cloudflare quiche's example client against
quiche's example server on localhost with `QLOGDIR` set on **both** sides —
the same 5-request exchange observed from both ends:

- `quiche-localhost-client.sqlog.gz` — `vantage_point.type: client`
- `quiche-localhost-server.sqlog.gz` — `vantage_point.type: server`

These are the only samples using **spec-final** qlog output (the aioquic/curl
samples are draft-0.3): no `qlog_version` (the header self-identifies via
`"file_schema": "urn:ietf:params:qlog:file:sequential"` and
`event_schemas: ["urn:ietf:params:qlog:events:quic-12", ...]`), current
`quic:` / `http3:` event namespaces, object-form `reference_time`
(`{clock_type: "monotonic", epoch: "unknown", wall_clock_time: <RFC3339>}` —
anchored via `wall_clock_time`), RawInfo frame lengths
(`frame.raw.payload_length` instead of draft `frame.length`), and
`quic:recovery_metrics_updated` (the recovery namespace folded into `quic:`).

Regenerate (needs Rust + cmake; BoringSSL bindgen may need
`BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/x86_64-linux-gnu/<ver>/include"`
when only libclang without its resource headers is installed):

```
git clone --depth 1 --recurse-submodules https://github.com/cloudflare/quiche.git
cd quiche && cargo build --release --bin quiche-client --bin quiche-server
QLOGDIR=server-qlogs ./target/release/quiche-server --listen 127.0.0.1:4433 \
  --cert quiche/examples/cert.crt --key quiche/examples/cert.key --root <htdocs> &
QLOGDIR=client-qlogs ./target/release/quiche-client --no-verify \
  https://127.0.0.1:4433/index.html https://127.0.0.1:4433/style.css ...
```

Files are named `{role}-{qlog id}.sqlog`; pair client/server logs for the same
connection by matching the server's `scid` in the client's `packet_received`
headers (or just by wall_clock_time proximity).

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
