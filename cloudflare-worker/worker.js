/*
 * Copyright 2026 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 *
 * waterfall-tools CORS fetch proxy — Cloudflare Worker
 *
 * Proxies GET /fetch?url=<absolute http(s) URL> for waterfall-tools URL imports,
 * adding `Access-Control-Allow-Origin: *` so browser fetch() works cross-origin.
 * Non-/fetch paths are passed through untouched.
 *
 * Abuse protections:
 *   - Format sniff (first 64KB): only known waterfall-tools formats are allowed.
 *   - Hard wire-byte cap on the forwarded body (streaming-safe; not reliant on
 *     upstream Content-Length).
 *   - Full-request deadline — DoH resolve, upstream fetch, and body stream all
 *     share a single AbortController so a slow-drip origin can't run forever.
 *   - Manual redirects with per-hop SSRF re-validation.
 *   - DoH (Cloudflare 1.1.1.1) pre-resolve of each hop's hostname — resolved
 *     A/AAAA records are checked against the private-address blocklist so a
 *     hostname pointing at 127.0.0.1 (or RFC1918 etc.) is refused even if the
 *     hostname string looks public. Fail-closed on DoH errors / NXDOMAIN.
 *   - Forwards caller IP + User-Agent via X-Forwarded-For / Forwarded /
 *     X-Real-IP / Via — non-anonymizing.
 *   - Refuses self-recursive targets (?url=https://<this host>/fetch?...).
 *   - Per-IP rate limits (per isolate): failure cap + total-attempts cap.
 *     IPv6 clients are keyed by /64 prefix so a single attacker's block
 *     doesn't get unlimited buckets.
 *
 * Maintenance: the format sniff below mirrors src/inputs/orchestrator.js's
 * identifyFormatFromBuffer — keep them in sync (see AGENTS.md §76).
 *
 * Deployment: plain ES module Worker, no bindings. `wrangler deploy` or paste
 * into the dashboard.
 */

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

const SNIFF_SIZE = 65536;
const GZIP_SNIFF_DECOMPRESSED_CAP = 65536;

// Full request deadline — covers DoH, upstream fetch, and the entire body
// stream (NOT just the initial fetch handshake).
const FULL_REQUEST_TIMEOUT_MS = 120_000;        // 2 minutes

// Per-DoH-query deadline (still respects the parent full-request deadline).
const DOH_TIMEOUT_MS = 5_000;

const RATE_LIMIT_WINDOW_SECONDS = 600;
const RATE_LIMIT_MAX_FAILURES = 10;             // 429 after this many failures/IP/window
const RATE_LIMIT_MAX_REQUESTS = 100;            // 429 after this many total requests/IP/window
const RATE_LIMIT_MAP_CAP = 100;                 // kept small; see rate-limit block comment

// Wire-byte cap on the forwarded response body. A waterfall input bigger than
// this won't fit in a browser anyway, and the cap is what prevents an upstream
// that lies about (or omits) Content-Length from using us as a bandwidth amp.
const MAX_CONTENT_LENGTH_BYTES = 100 * 1024 * 1024; // 100 MiB

// Cap on the raw `url=` query parameter length.
const MAX_TARGET_URL_LENGTH = 2048;

// Max redirect hops we'll follow. Each hop is re-validated against the SSRF
// blocklist AND re-resolved via DoH.
const MAX_REDIRECTS = 5;

// Cloudflare's public DoH endpoint (application/dns-json).
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

// -----------------------------------------------------------------------------
// Worker entry
// -----------------------------------------------------------------------------

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Only /fetch is ours; everything else passes through.
        if (url.pathname !== '/fetch') {
            return fetch(request);
        }

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // Only GET is supported. HEAD would bypass format sniffing (no body),
        // turning us into a generic reachability probe for arbitrary hosts.
        if (request.method !== 'GET') {
            return jsonError(405, 'method_not_allowed', 'Only GET is supported on /fetch.');
        }

        // Range requests are not supported — the waterfall-tools client never
        // issues them, and allowing partial fetches would let a caller skip
        // past the sniff window entirely.
        if (request.headers.has('Range')) {
            return jsonError(400, 'range_not_supported', 'Range requests are not supported on /fetch.');
        }

        const clientIp = getClientIp(request);
        const rlKey = rateLimitKeyFor(clientIp);

        if (isRateLimited(rlKey)) {
            return jsonError(
                429,
                'rate_limited',
                `Too many requests or failures from this source. Try again later.`,
            );
        }

        return handleFetch(request, url, clientIp, rlKey);
    },
};

// -----------------------------------------------------------------------------
// Core proxy handler
// -----------------------------------------------------------------------------

async function handleFetch(request, url, clientIp, rlKey) {
    const target = url.searchParams.get('url');
    if (!target) {
        recordFailure(rlKey);
        return jsonError(400, 'missing_url', 'Query parameter `url` is required and must be URL-encoded.');
    }
    if (target.length > MAX_TARGET_URL_LENGTH) {
        recordFailure(rlKey);
        return jsonError(400, 'url_too_long', `URL must be ${MAX_TARGET_URL_LENGTH} characters or fewer.`);
    }

    let parsedTarget;
    try {
        parsedTarget = new URL(target);
    } catch (_e) {
        recordFailure(rlKey);
        return jsonError(400, 'invalid_url', 'The `url` parameter could not be parsed as an absolute URL.');
    }

    // Refuse self-recursive proxy: ?url=https://<this host>/fetch?url=…
    if (parsedTarget.hostname === url.hostname) {
        recordFailure(rlKey);
        return jsonError(400, 'recursive_proxy', 'Refusing to proxy URLs back to this host.');
    }

    // Single AbortController governs DoH + upstream fetch + body stream. We
    // intentionally do NOT clear the timeout once the initial fetch resolves
    // — a slow-drip body needs to abort too. Cleanup happens in buildReplayStream
    // (on close/cancel/error) and in each failure path below.
    const timeoutController = new AbortController();
    let timeoutId = setTimeout(() => timeoutController.abort(), FULL_REQUEST_TIMEOUT_MS);
    const clearRequestTimeout = () => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };

    // Walk the redirect chain manually so we can SSRF-validate every hop.
    let upstream = null;
    let currentUrl = parsedTarget;
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
                clearRequestTimeout();
                recordFailure(rlKey);
                return jsonError(400, 'unsupported_scheme', 'Only http and https are supported.');
            }
            if (isPrivateHost(currentUrl.hostname)) {
                clearRequestTimeout();
                recordFailure(rlKey);
                return jsonError(400, 'blocked_host', 'Refusing to fetch private/loopback/link-local hosts.');
            }

            // DoH pre-resolve SSRF. Narrows the rebinding window to the ms
            // between this check and Cloudflare's internal resolve.
            const dohResult = await resolveAndCheckHostname(currentUrl.hostname, timeoutController.signal);
            if (!dohResult.ok) {
                clearRequestTimeout();
                recordFailure(rlKey);
                return jsonError(
                    400,
                    'blocked_resolved_host',
                    `Hostname resolution refused: ${dohResult.reason}.`,
                );
            }

            const outboundHeaders = buildOutboundHeaders(request, clientIp, url);
            const response = await fetch(currentUrl.toString(), {
                method: 'GET',
                headers: outboundHeaders,
                redirect: 'manual',
                signal: timeoutController.signal,
            });

            // Redirect response — follow it after re-validation.
            const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
            if (isRedirect) {
                // Release the redirect body so the TCP/QUIC connection can
                // be reused by the next hop.
                try { await response.body?.cancel(); } catch (_e) { }

                const location = response.headers.get('Location');
                if (!location) {
                    clearRequestTimeout();
                    recordFailure(rlKey);
                    return jsonError(502, 'redirect_without_location', 'Upstream redirect missing Location header.');
                }

                if (hop >= MAX_REDIRECTS) {
                    clearRequestTimeout();
                    recordFailure(rlKey);
                    return jsonError(502, 'too_many_redirects', `Exceeded ${MAX_REDIRECTS} redirect hops.`);
                }

                let nextUrl;
                try {
                    nextUrl = new URL(location, currentUrl);
                } catch (_e) {
                    clearRequestTimeout();
                    recordFailure(rlKey);
                    return jsonError(502, 'invalid_redirect', 'Upstream Location header could not be parsed.');
                }
                currentUrl = nextUrl;
                continue;
            }

            upstream = response;
            break;
        }
    } catch (err) {
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(
            502,
            'upstream_fetch_failed',
            `Upstream fetch failed: ${err && err.message ? err.message : 'unknown error'}`,
        );
    }

    if (!upstream) {
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(502, 'upstream_fetch_failed', 'Upstream returned no response.');
    }

    if (!upstream.ok) {
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(
            502,
            'upstream_status',
            `Upstream returned HTTP ${upstream.status}.`,
            { upstream_status: upstream.status },
        );
    }

    const contentLengthHeader = upstream.headers.get('Content-Length');
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH_BYTES) {
            clearRequestTimeout();
            recordFailure(rlKey);
            return jsonError(413, 'payload_too_large', `Upstream payload exceeds ${MAX_CONTENT_LENGTH_BYTES} bytes.`);
        }
    }

    if (!upstream.body) {
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(502, 'empty_body', 'Upstream returned no body to sniff.');
    }

    // Read up to SNIFF_SIZE bytes as discrete chunks for replay. Remaining
    // stream bytes are forwarded without buffering.
    const reader = upstream.body.getReader();
    const sniffedChunks = [];
    let sniffedBytes = 0;
    let upstreamDone = false;
    try {
        while (sniffedBytes < SNIFF_SIZE) {
            const { done, value } = await reader.read();
            if (done) {
                upstreamDone = true;
                break;
            }
            if (value && value.byteLength) {
                sniffedChunks.push(value);
                sniffedBytes += value.byteLength;
            }
        }
    } catch (err) {
        try { await reader.cancel(); } catch (_e) { }
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(
            502,
            'upstream_read_failed',
            `Failed reading upstream body: ${err && err.message ? err.message : 'unknown error'}`,
        );
    }

    const sniffPrefix = concatUint8(sniffedChunks, Math.min(sniffedBytes, SNIFF_SIZE));
    let format;
    try {
        format = await identifyFormatFromBuffer(sniffPrefix);
    } catch (err) {
        try { await reader.cancel(); } catch (_e) { }
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(
            500,
            'sniff_failed',
            `Format sniff failed: ${err && err.message ? err.message : 'unknown error'}`,
        );
    }

    if (format === 'unknown') {
        try { await reader.cancel(); } catch (_e) { }
        clearRequestTimeout();
        recordFailure(rlKey);
        return jsonError(
            415,
            'unsupported_format',
            'Upstream content did not match any format supported by waterfall-tools.',
        );
    }

    // Replay sniffed chunks, then stream remainder through unchanged — but
    // enforce MAX_CONTENT_LENGTH_BYTES on the wire bytes delivered downstream
    // and clean up the request-deadline timer when the stream ends.
    const body = buildReplayStream(sniffedChunks, reader, upstreamDone, clearRequestTimeout);

    // At this point the response is being handed off to the runtime. Count
    // it as a successful attempt against the per-IP total cap.
    recordSuccess(rlKey);

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Encoding, Last-Modified, ETag, X-Waterfall-Tools-Format');
    headers.set('X-Waterfall-Tools-Format', format);

    // Preserve upstream framing. Content-Encoding passes through verbatim —
    // sniffing decompressed only an in-memory copy of the prefix.
    copyHeaderIfPresent(upstream.headers, headers, 'Content-Type');
    copyHeaderIfPresent(upstream.headers, headers, 'Content-Length');
    copyHeaderIfPresent(upstream.headers, headers, 'Content-Encoding');
    copyHeaderIfPresent(upstream.headers, headers, 'Last-Modified');
    copyHeaderIfPresent(upstream.headers, headers, 'ETag');
    copyHeaderIfPresent(upstream.headers, headers, 'Cache-Control');

    return new Response(body, {
        status: 200,
        headers,
    });
}

function buildOutboundHeaders(request, clientIp, url) {
    const outboundHeaders = new Headers();
    const callerUA = request.headers.get('User-Agent');
    outboundHeaders.set('User-Agent', callerUA || 'waterfall-tools-proxy/1.0');
    outboundHeaders.set('Accept', '*/*');

    const existingXFF = request.headers.get('X-Forwarded-For');
    outboundHeaders.set('X-Forwarded-For', existingXFF ? `${existingXFF}, ${clientIp}` : clientIp);
    outboundHeaders.set('X-Real-IP', clientIp);
    outboundHeaders.set('Forwarded', `for=${quoteForForwardedHeader(clientIp)};proto=${url.protocol.replace(':', '')};host=${url.host}`);
    outboundHeaders.set('Via', '1.1 waterfall-tools-proxy');

    return outboundHeaders;
}

// -----------------------------------------------------------------------------
// Stream replay: sniffed prefix bytes first, then the live reader remainder.
// Enforces MAX_CONTENT_LENGTH_BYTES on total wire bytes and clears the
// request deadline timer when the stream terminates.
// -----------------------------------------------------------------------------

function buildReplayStream(sniffedChunks, reader, alreadyDone, onDone) {
    let prefixIndex = 0;
    let totalEnqueued = 0;
    let finalized = false;
    const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (onDone) {
            try { onDone(); } catch (_e) { }
        }
    };

    return new ReadableStream({
        pull(controller) {
            // Drain the buffered sniff prefix one chunk per pull so we keep
            // backpressure with the downstream consumer rather than enqueuing
            // the whole 64KB window at once.
            if (prefixIndex < sniffedChunks.length) {
                const chunk = sniffedChunks[prefixIndex++];
                totalEnqueued += chunk.byteLength;
                controller.enqueue(chunk);
                return;
            }
            if (alreadyDone) {
                finalize();
                controller.close();
                return;
            }
            return reader.read().then(({ done, value }) => {
                if (done) {
                    finalize();
                    controller.close();
                    return;
                }
                if (value && value.byteLength) {
                    if (totalEnqueued + value.byteLength > MAX_CONTENT_LENGTH_BYTES) {
                        finalize();
                        controller.error(new Error(`Upstream body exceeded ${MAX_CONTENT_LENGTH_BYTES} bytes.`));
                        try { reader.cancel(); } catch (_e) { }
                        return;
                    }
                    totalEnqueued += value.byteLength;
                    controller.enqueue(value);
                }
            }).catch((err) => {
                finalize();
                controller.error(err);
                try { reader.cancel(); } catch (_e) { }
            });
        },
        cancel(reason) {
            finalize();
            try { reader.cancel(reason); } catch (_e) { }
        },
    });
}

// -----------------------------------------------------------------------------
// Format sniffing — mirror of src/inputs/orchestrator.js. Keep in sync.
// -----------------------------------------------------------------------------

async function identifyFormatFromBuffer(buf) {
    if (!buf || buf.length === 0) return 'unknown';

    const gzipped = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

    let textBuf = buf;
    if (gzipped) {
        textBuf = await gunzipPrefix(buf);
    }

    // ZIP (wptagent bundles). Require at least one distinctive wptagent
    // member filename within the first 64KB so we don't accept arbitrary
    // zip files. The central directory lives at the end of the archive, but
    // each member is preceded by a local file header containing its name.
    if (textBuf.length >= 4) {
        const magic = readUint32BE(textBuf, 0);
        if (magic === 0x504b0304 && looksLikeWptagentZip(textBuf)) return 'wptagent';
    }

    // PCAP / PCAPNG magic (tcpdump)
    if (textBuf.length >= 4) {
        const magic = readUint32BE(textBuf, 0);
        const magicLE = readUint32LE(textBuf, 0);
        const pcapMagics = [0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a];
        if (pcapMagics.includes(magic) || pcapMagics.includes(magicLE)) return 'tcpdump';
    }

    // Perfetto protobuf: first byte is TracePacket tag (0x0a = field 1, wire 2).
    if (textBuf.length >= 4 && textBuf[0] === 0x0a) {
        let len = 0, shift = 0, o = 1;
        while (o < textBuf.length && o < 5) {
            const b = textBuf[o++];
            len |= (b & 0x7f) << shift;
            shift += 7;
            if (!(b & 0x80)) break;
        }
        if (textBuf.length > o + len && textBuf[o + len] === 0x0a) {
            return 'perfetto';
        }
    }

    // Text-based JSON formats
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(textBuf.subarray(0, Math.min(textBuf.length, SNIFF_SIZE)));
    const minText = text.replace(/\s/g, '');

    if (text.includes('org.chromium.trace_metadata') || text.includes('Perfetto v') || text.includes('TracePacket')) return 'perfetto';
    if (minText.includes('{"constants":') && minText.includes('"logEventTypes":')) return 'netlog';
    if (minText.includes('CLIENT_RANDOM') || minText.includes('CLIENT_HANDSHAKE_TRAFFIC_SECRET') || minText.includes('CLIENT_TRAFFIC_SECRET_0')) return 'keylog';
    if ((minText.startsWith('{"data":{') || minText.includes('"data":{')) &&
        (minText.includes('"median":') || minText.includes('"runs":') || minText.includes('"testRuns":') || minText.includes('"average":'))) return 'wpt';
    if (minText.startsWith('{"traceEvents":') || (minText.includes('{"pid":') && minText.includes('"ts":') && minText.includes('"cat":'))) return 'chrome-trace';
    if (minText.startsWith('[{"pid":') || minText.startsWith('[{"cat":') || minText.startsWith('[{"name":')) return 'chrome-trace';
    if (minText.startsWith('[{"method":"') || minText.includes('{"method":"Network.')) return 'cdp';
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":') || minText.includes('{"log":{"pages":')) return 'har';

    return 'unknown';
}

// Distinctive wptagent member filenames. The first 64KB of a wptagent zip is
// expected to contain at least one of these (as a substring inside a local
// file header). Covers both video-enabled and video-disabled captures,
// first-view and repeat-view (`_Cached_` prefix folds into the same tokens).
const WPTAGENT_FILENAME_TOKENS = [
    'testinfo.json',
    'testinfo.ini',
    'video_1/ms_',
    'video_1_cached/ms_',
    '_devtools_requests.json',
    '_netlog_requests.json',
    '_page_data.json',
    '_visual_progress.json',
    '_timed_events.json',
    '_script_timing.json',
    '_trace.json.gz',
    '_timeline_cpu.json',
    '_long_tasks.json',
    '_interactive.json',
    'lighthouse.json.gz',
    '_bodies.zip',
];

function looksLikeWptagentZip(buf) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buf.subarray(0, Math.min(buf.length, SNIFF_SIZE)));
    for (const token of WPTAGENT_FILENAME_TOKENS) {
        if (text.includes(token)) return true;
    }
    return false;
}

// Best-effort decompress of the first ~64KB of a gzipped buffer. Falls back
// to the raw input on error.
async function gunzipPrefix(buf) {
    try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(buf).catch(() => { });
        writer.close().catch(() => { });

        const reader = ds.readable.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
                chunks.push(value);
                total += value.byteLength;
                if (total >= GZIP_SNIFF_DECOMPRESSED_CAP) {
                    try { await reader.cancel(); } catch (_e) { }
                    break;
                }
            }
        }
        if (total === 0) return buf;
        return concatUint8(chunks, total);
    } catch (_e) {
        return buf;
    }
}

// -----------------------------------------------------------------------------
// DoH (DNS-over-HTTPS) SSRF pre-resolve
// -----------------------------------------------------------------------------
//
// Cloudflare Workers' outbound fetch resolves DNS internally and doesn't
// surface the resolved IP on the response, so we can't do a post-hoc check.
// Instead we resolve the hostname ourselves via Cloudflare's public DoH
// (cloudflare-dns.com) and reject if any returned A/AAAA record lives in
// the private-address blocklist. This closes the "public hostname whose DNS
// returns 127.0.0.1" attack. There's still a small TOCTOU window between
// our resolve and Cloudflare's — don't rely on this as the only control.
//
// We fail-closed: if DoH times out, errors, or returns no A/AAAA records,
// we refuse the fetch.

async function resolveAndCheckHostname(hostname, parentSignal) {
    // Literal IPs are already handled by isPrivateHost() at the caller; no
    // DNS lookup needed.
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.startsWith('[')) {
        return { ok: true };
    }

    const [aAnswers, aaaaAnswers] = await Promise.all([
        dohLookup(hostname, 'A', parentSignal),
        dohLookup(hostname, 'AAAA', parentSignal),
    ]);

    for (const ip of aAnswers) {
        if (isPrivateIPv4(ip)) return { ok: false, reason: `A record ${ip} is private` };
    }
    for (const ip of aaaaAnswers) {
        if (isPrivateIPv6(ip)) return { ok: false, reason: `AAAA record ${ip} is private` };
    }

    // Fail-closed when we get nothing back — we can't confirm the hostname
    // is safe, and legitimate targets have at least one A or AAAA record.
    if (aAnswers.length === 0 && aaaaAnswers.length === 0) {
        return { ok: false, reason: 'no A/AAAA records returned (DoH failure or NXDOMAIN)' };
    }

    return { ok: true };
}

async function dohLookup(hostname, type, parentSignal) {
    const controller = new AbortController();
    const childTimeout = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
        const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
        const r = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/dns-json' },
            signal: controller.signal,
        });
        if (!r.ok) return [];
        const j = await r.json();
        // Status 0 = NOERROR. Anything else (NXDOMAIN=3, SERVFAIL=2, etc.)
        // falls through to "no records".
        if (j.Status !== 0 || !Array.isArray(j.Answer)) return [];
        const recordType = type === 'A' ? 1 : 28; // RFC 1035 / RFC 3596 numeric types
        return j.Answer
            .filter((a) => a && a.type === recordType && typeof a.data === 'string')
            .map((a) => a.data.trim());
    } catch (_e) {
        return [];
    } finally {
        clearTimeout(childTimeout);
        if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
}

// -----------------------------------------------------------------------------
// In-memory rate limiting (per isolate)
// -----------------------------------------------------------------------------
//
// Counters are per-isolate: Cloudflare keeps isolates warm and repeat requests
// from the same client normally land on the same isolate in the same colo, so
// this is enough to stop a single attacker hammering a single Worker instance.
// No KV / D1 / Durable Object binding required.
//
// Each record tracks two counts — totalCount (all /fetch attempts) and
// failureCount (subset that returned an error). Either crossing its cap
// within the window triggers 429. The separate caps let us shape behavior:
// a rare but useful caller can spend all 100 on successes, while a broken
// script is cut off after 10 failures.
//
// IPv6 clients are keyed by /64 prefix so a single attacker with a /64 block
// can't mint unlimited buckets.
//
// Entries expire lazily on read once older than RATE_LIMIT_WINDOW_SECONDS.
// The map is capped (RATE_LIMIT_MAP_CAP); when full of still-active entries
// we fail-closed and 429 all /fetch requests rather than evict a real
// offender — otherwise an attacker could flood us with unique IPs to roll
// the real offender off the FIFO tail.

/** @type {Map<string, { totalCount: number, failureCount: number, firstMs: number }>} */
const rateLimitMap = new Map();

function isRateLimited(key) {
    const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
    const now = Date.now();

    // Fail-closed global lockout when the tracking map is full of still-active
    // entries. See block comment above for rationale.
    if (rateLimitMap.size >= RATE_LIMIT_MAP_CAP) {
        const oldestEntry = rateLimitMap.values().next().value;
        if (oldestEntry && now - oldestEntry.firstMs <= windowMs) {
            return true;
        }
    }

    if (!key) return false;
    const record = rateLimitMap.get(key);
    if (!record) return false;
    if (now - record.firstMs > windowMs) {
        rateLimitMap.delete(key);
        return false;
    }
    return record.failureCount >= RATE_LIMIT_MAX_FAILURES ||
        record.totalCount >= RATE_LIMIT_MAX_REQUESTS;
}

function bumpCounter(key, isFailure) {
    if (!key) return;
    const now = Date.now();
    const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;

    const record = rateLimitMap.get(key);
    if (record && now - record.firstMs <= windowMs) {
        record.totalCount += 1;
        if (isFailure) record.failureCount += 1;
        return;
    }

    // New entry (or window rolled over). At cap, only evict the oldest if it
    // has itself aged out — never evict an active entry (see block comment).
    if (rateLimitMap.size >= RATE_LIMIT_MAP_CAP) {
        const oldestKey = rateLimitMap.keys().next().value;
        if (oldestKey === undefined) return;
        const oldestEntry = rateLimitMap.get(oldestKey);
        if (oldestEntry && now - oldestEntry.firstMs > windowMs) {
            rateLimitMap.delete(oldestKey);
        } else {
            return;
        }
    }
    rateLimitMap.set(key, {
        totalCount: 1,
        failureCount: isFailure ? 1 : 0,
        firstMs: now,
    });
}

function recordFailure(key) { bumpCounter(key, true); }
function recordSuccess(key) { bumpCounter(key, false); }

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

// Prefer Cloudflare's CF-Connecting-IP; fall back to XFF for `wrangler dev`.
function getClientIp(request) {
    const cf = request.headers.get('CF-Connecting-IP');
    if (cf) return cf.trim();
    const xff = request.headers.get('X-Forwarded-For');
    if (xff) return xff.split(',')[0].trim();
    return 'unknown';
}

// Rate-limit bucketing. IPv4 addresses key on the full address. IPv6 clients
// collapse to their /64 prefix so an attacker with a routed /64 block can't
// mint unlimited buckets (the smallest unit ISPs routinely hand out).
function rateLimitKeyFor(ip) {
    if (!ip) return null;
    if (!ip.includes(':')) return ip; // IPv4 or the literal "unknown"

    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — rare from CF; key by the full form.
    if (/::ffff:\d/i.test(ip)) return ip;

    // Expand the `::` shorthand so we can reliably take the first 4 groups.
    let full;
    if (ip.includes('::')) {
        const [left, right] = ip.split('::');
        const l = left ? left.split(':') : [];
        const r = right ? right.split(':') : [];
        const zeros = Array(Math.max(0, 8 - l.length - r.length)).fill('0');
        full = [...l, ...zeros, ...r];
    } else {
        full = ip.split(':');
    }
    if (full.length < 4) return ip; // malformed — fall back to the raw string
    return full.slice(0, 4).join(':') + '::/64';
}

// Hostname-string SSRF guard. Blocks naive attacks (localhost, 127.0.0.1,
// 169.254.169.254, etc). NOT a substitute for DoH-based resolution checks —
// see resolveAndCheckHostname.
function isPrivateHost(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();

    if (h === 'localhost' || h === 'localhost.localdomain') return true;
    if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;

    // IPv6 literal (bracketed).
    if (h.startsWith('[') && h.endsWith(']')) {
        return isPrivateIPv6(h.slice(1, -1));
    }

    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isPrivateIPv4(h);

    return false;
}

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;                              // 0.0.0.0/8
    if (a === 10) return true;                             // 10/8
    if (a === 127) return true;                            // loopback
    if (a === 169 && b === 254) return true;               // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
    if (a === 192 && b === 168) return true;               // 192.168/16
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
    if (a >= 224) return true;                             // multicast/reserved
    return false;
}

function isPrivateIPv6(ip) {
    if (!ip) return true;
    const h = ip.toLowerCase().trim();
    if (h === '::1' || h === '::') return true;

    // ULA fc00::/7 (both fc.. and fd.. first byte).
    if (/^fc[0-9a-f]{0,2}:/i.test(h) || /^fd[0-9a-f]{0,2}:/i.test(h)) return true;

    // Link-local fe80::/10 — first 10 bits are 1111111010, covering
    // fe80–febf. Guard against false matches on public addresses like
    // "fe00:..." by matching only the fe80..febf range.
    if (/^fe[89ab][0-9a-f]?:/i.test(h)) return true;

    // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    const mappedMatch = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedMatch) return isPrivateIPv4(mappedMatch[1]);

    // 64:ff9b::/96 (NAT64) and 100::/64 (discard prefix) — forwarding traffic
    // into these ranges can still hit private hosts depending on the
    // deployment, so treat them as suspicious.
    if (h.startsWith('64:ff9b:')) return true;
    if (/^100:0?:0?:0?:/i.test(h) || h === '100::') return true;

    return false;
}

// RFC 7239: IPv6 addresses (anything with a colon) must be double-quoted.
function quoteForForwardedHeader(ip) {
    if (/[:"]/.test(ip)) return `"${ip.replace(/"/g, '')}"`;
    return ip;
}

function copyHeaderIfPresent(src, dst, name) {
    const v = src.get(name);
    if (v != null) dst.set(name, v);
}

function concatUint8(chunks, totalLen) {
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
        if (offset + c.byteLength > totalLen) {
            out.set(c.subarray(0, totalLen - offset), offset);
            offset = totalLen;
            break;
        }
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out;
}

function readUint32BE(buf, offset) {
    return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function readUint32LE(buf, offset) {
    return ((buf[offset + 3] << 24) | (buf[offset + 2] << 16) | (buf[offset + 1] << 8) | buf[offset]) >>> 0;
}

function jsonError(status, code, message, extra) {
    const body = JSON.stringify({ error: code, message, ...(extra || {}) });
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        },
    });
}
