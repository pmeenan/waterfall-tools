# waterfall-tools CORS fetch proxy (Cloudflare Worker)

A single-file Cloudflare Worker that acts as a **CORS-friendly fetch fallback**
for waterfall-tools URL-based imports. When the browser can't fetch a remote
trace directly because the origin doesn't send CORS headers, the viewer can
retry the fetch through this Worker, which adds `Access-Control-Allow-Origin: *`
on the proxied response.

## What it does

- Handles **only** `GET /fetch?url=<URL-encoded URL>` requests. Every other
  path is passed through to whatever the Worker route is also serving (so it
  can be safely co-hosted with other content).
- Sniffs the first 64 KB of the upstream response and allows the stream to
  continue **only if** the content matches a format waterfall-tools actually
  parses (HAR, WPT JSON, Netlog, CDP, Chrome Trace, Perfetto, wptagent ZIP,
  pcap/pcapng, TLS key log). Any other content is rejected with 415.
- Streams the matched response body back to the caller **byte-for-byte**
  from the point where sniffing finished — no reassembly, no content
  transformation.
- Deliberately **non-anonymizing**: forwards the caller's client IP via
  `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, and `Via` so upstream servers
  can see who is actually driving the request.
- Refuses obvious SSRF targets (loopback, private RFC 1918 ranges,
  link-local, CGNAT, `.internal` / `.local` hostnames, non-http schemes).
- Per-IP failure rate limit: after 10 failed fetches within 10 minutes, the
  IP is 429'd until the window rolls over. Bookkeeping is an in-memory
  `Map` inside the Worker isolate — no KV / D1 / Durable Object binding is
  required. Clients issuing repeat requests normally land on the same warm
  isolate within a colo, which is sufficient to block a single attacker.
- **Fail-closed at capacity:** the tracking map is capped (default 10 000
  distinct IPs). When the cap is reached and every tracked entry is still
  inside its active window, the Worker refuses to evict any of them
  (otherwise an attacker could flood unique IPs to roll a real offender off
  the FIFO tail) and instead rejects **all** `/fetch` requests with 429
  until the oldest tracked entry ages out. This prevents the rate limiter
  from being silently defeated by overflow.

## Deploy

### Option A — paste into the dashboard

1. Cloudflare dashboard → Workers & Pages → Create → Hello World → Module Worker.
2. Replace the generated `worker.js` with the contents of [`worker.js`](./worker.js).
3. Save & deploy.
4. Add a route (e.g. `proxy.example.com/*`) in the Worker's Triggers tab.

### Option B — Wrangler

```bash
npx wrangler deploy cloudflare-worker/worker.js --name waterfall-tools-proxy
```

An example `wrangler.toml`:

```toml
name = "waterfall-tools-proxy"
main = "worker.js"
compatibility_date = "2025-01-01"
```

No bindings are required.

## Use it from the waterfall-tools viewer

When the direct fetch fails with a CORS error, retry through the proxy:

```js
const target = 'https://example.com/trace.har';
const proxied = `https://proxy.example.com/fetch?url=${encodeURIComponent(target)}`;
const res = await fetch(proxied);
```

## Adding new input formats

**Important:** when a new input format is added to
`src/inputs/orchestrator.js`, the format-sniffing block in
[`worker.js`](./worker.js) (`identifyFormatFromBuffer`) MUST be updated to
match. Otherwise the new format will be silently rejected by the proxy as
"unsupported_format". See `AGENTS.md` for the full contract.

## Tuning

Constants at the top of `worker.js`:

| Constant                       | Default  | Purpose                                               |
| ------------------------------ | -------- | ----------------------------------------------------- |
| `SNIFF_SIZE`                   | 65536    | Max bytes buffered before the format decision.        |
| `UPSTREAM_TIMEOUT_MS`          | 30 000   | Hard timeout on the upstream fetch.                   |
| `RATE_LIMIT_WINDOW_SECONDS`    | 600      | Rolling window for the per-IP failure counter.        |
| `RATE_LIMIT_MAX_FAILURES`      | 10       | Failures in the window before the IP is 429'd.        |
| `MAX_CONTENT_LENGTH_BYTES`     | 2 GiB    | Upstream Content-Length cap.                          |

## Threat model notes

- The failure-counter is kept in-memory per Worker isolate. A sufficiently
  distributed attacker whose requests hash across many isolates / colos
  could see moderately higher effective limits in aggregate; per-isolate
  enforcement is considered sufficient given that the format-sniff step
  already blocks the vast majority of open-proxy abuse.
- The SSRF check is a best-effort hostname / IP-literal block — it does
  **not** resolve hostnames, so an attacker-controlled DNS record that
  resolves to a private address still technically bypasses it. If you deploy
  on a network that exposes private services behind public-looking DNS,
  combine this Worker with a network-level allow-list.
