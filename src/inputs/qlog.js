/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview qlog (IETF QUIC/HTTP-3 structured logging) Input Processor
 *
 * Maps qlog captures (curl/ngtcp2 `.sqlog` JSON-SEQ, aioquic `.qlog` plain JSON, and
 * spec-compliant future files) into the Extended HAR intermediary structure. One qlog file
 * carries one QUIC connection in practice; `processQlogNode` also accepts an ARRAY of
 * inputs so multiple per-connection files merge into a single page (the viewer drops
 * several files at once).
 *
 * Two fidelity modes per trace:
 *  - Rich (h3 events present, e.g. aioquic): real method/URL/status/headers from the
 *    decoded HTTP/3 HEADERS frames.
 *  - Degraded (transport-only, e.g. curl/ngtcp2): requests are still visible as
 *    client-initiated bidirectional streams (stream_id % 4 === 0); entries get synthetic
 *    `https://connection-<odcid8>/stream-<id>` URLs and `_statusAssumed` (rumcap precedent).
 *
 * Clock model: every `_` timing field is a relative-ms offset from page zero. Anchored
 * traces (truthy reference_time, or absolute epoch-ms event times) align by wall clock;
 * unanchored traces (curl's `reference_time: 0`) anchor at page zero and set
 * `page._clockSynthesized` — the epoch is synthesized (Date.now()), never 1970.
 */
import { buildWaterfallDataFromHar } from '../core/har-converter.js';
import { VERSION } from '../core/version.js';
import {
    decodeQlogTraces,
    normalizeEventName,
    resolveClock,
    createTimeConverter
} from './utilities/qlog/decoder.js';

function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Round a relative-ms value to µs precision so float subtraction noise (epoch-sized
 *  doubles) never leaks into fixtures or the HAR output. */
function round3(v) {
    return Math.round(v * 1000) / 1000;
}

/**
 * Collect an entire web ReadableStream into a single Uint8Array, reporting read progress.
 * @param {ReadableStream} stream
 * @param {function(string, number): void} onProgress
 * @param {number} totalBytes - 0 when unknown
 * @returns {Promise<Uint8Array>}
 */
async function collectStream(stream, onProgress, totalBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let bytesRead = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            bytesRead += value.length;
            if (totalBytes > 0) {
                onProgress('Reading qlog...', Math.min(40, Math.round((bytesRead / totalBytes) * 40)));
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
    const out = new Uint8Array(bytesRead);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/**
 * Resolve one input (path / Node Readable / web ReadableStream / Uint8Array / ArrayBuffer)
 * to raw bytes, inflating a user-applied outer gzip layer detected by magic bytes (never
 * by extension — every repo sample is gzipped without changing the sniffable content).
 * @returns {Promise<Uint8Array>}
 */
async function loadInputBytes(input, onProgress, totalBytes) {
    let bytes;
    let nodeFsStream = null;
    try {
        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            if (!totalBytes) {
                try { totalBytes = fs.statSync(input).size; } catch { /* progress stays coarse */ }
            }
            nodeFsStream = fs.createReadStream(input);
            bytes = await collectStream(Readable.toWeb(nodeFsStream), onProgress, totalBytes);
        } else if (input instanceof Uint8Array) {
            bytes = input;
        } else if (input instanceof ArrayBuffer) {
            bytes = new Uint8Array(input);
        } else if (input && typeof input.getReader === 'function') {
            bytes = await collectStream(input, onProgress, totalBytes);
        } else if (input && typeof input.pipe === 'function') {
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            bytes = await collectStream(Readable.toWeb(input), onProgress, totalBytes);
        } else {
            throw new Error('Unsupported input type for qlog parser');
        }
    } finally {
        if (nodeFsStream) nodeFsStream.destroy();
    }

    if (isGzip(bytes)) {
        onProgress('Decompressing qlog...', 42);
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = await collectStream(stream, () => {}, 0);
    }
    return bytes;
}

/** RFC 9218 urgency → WPT priority label, matching the tcpdump HTTP/3 mapping exactly. */
function priorityFromUrgency(urgency) {
    if (urgency <= 1) return 'Highest';
    if (urgency <= 2) return 'High';
    if (urgency <= 3) return 'Medium';
    if (urgency <= 5) return 'Low';
    return 'Lowest';
}

/** Lazily create the per-stream accumulator inside a trace model. */
function getStream(model, id) {
    let s = model.streams.get(id);
    if (!s) {
        s = {
            id,
            firstT: null,          // first observed activity of any kind on the stream
            tx: [],                // client→server STREAM frames: {t, bytes, fin}
            rx: [],                // server→client STREAM frames: {t, bytes, fin}
            txBytes: 0,
            rxBytes: 0,
            reqHeaders: null,      // decoded h3 request headers [{name, value}]
            reqTime: null,
            respHeaders: null,
            respTime: null,        // first response HEADERS evidence (interim included)
            respStatus: null,
            excluded: false        // control / QPACK / push streams never become entries
        };
        model.streams.set(id, s);
    }
    return s;
}

function touchStream(stream, t) {
    if (stream.firstT === null || t < stream.firstT) stream.firstT = t;
}

/**
 * Fold one packet event's STREAM frames into the per-stream tx/rx ledgers and track
 * handshake / bandwidth signals.
 * @param {Object} model
 * @param {string} dir - 'c2s' | 's2c' (semantic direction — vantage already applied)
 * @param {number} t - trace-relative ms
 * @param {Object} data - qlog packet event data
 */
function handlePacket(model, dir, t, data) {
    if (model.handshakeStart === null || t < model.handshakeStart) model.handshakeStart = t;

    const header = data.header || {};
    if (header.packet_type === '1RTT' && model.first1Rtt === null) {
        model.first1Rtt = t;
    }

    // Wire size for the bandwidth window: server→client packets only (that's the
    // download direction the `_bwDown` estimate models, mirroring tcpdump).
    if (dir === 's2c') {
        const raw = data.raw || {};
        const size = typeof raw.length === 'number' ? raw.length
            : (typeof raw.payload_length === 'number' ? raw.payload_length : null);
        if (size !== null && size > 0) model.rxPackets.push({ t, bytes: size });
    }

    const frames = Array.isArray(data.frames) ? data.frames : [];
    // Coalesce multiple STREAM frames for the same stream inside one packet — they land
    // at the same instant, and one chunk per packet is the granularity consumers expect.
    let perStream = null;
    for (const frame of frames) {
        if (!frame || typeof frame !== 'object') continue;
        if (frame.frame_type === 'stream') {
            const sid = Number(frame.stream_id);
            if (!Number.isFinite(sid)) continue;
            // Draft-0.3 producers put the stream data length directly on the frame
            // (`length`); spec-final producers (quiche) nest a RawInfo where
            // `payload_length` is the stream data and `length` is the full frame
            // including headers — prefer the payload semantics in that order.
            const raw = frame.raw || {};
            const len = Number(frame.length) || Number(raw.payload_length) || Number(raw.length) || 0;
            if (!perStream) perStream = new Map();
            const acc = perStream.get(sid) || { bytes: 0, fin: false };
            acc.bytes += len;
            acc.fin = acc.fin || frame.fin === true;
            perStream.set(sid, acc);
        } else if (frame.frame_type === 'handshake_done' && dir === 's2c') {
            // HANDSHAKE_DONE always travels server→client (RFC 9001): on a client vantage
            // it arrives in packet_received, on a server vantage it leaves in packet_sent —
            // the semantic direction check covers both.
            if (model.handshakeDone === null) model.handshakeDone = t;
        }
    }
    if (perStream) {
        for (const [sid, acc] of perStream) {
            const stream = getStream(model, sid);
            touchStream(stream, t);
            const record = { t, bytes: acc.bytes, fin: acc.fin };
            if (dir === 'c2s') {
                stream.tx.push(record);
                stream.txBytes += acc.bytes;
            } else {
                stream.rx.push(record);
                stream.rxBytes += acc.bytes;
            }
        }
    }
}

/**
 * Fold one HTTP/3 frame event into the owning stream's request/response state.
 * @param {Object} model
 * @param {string} side - 'request' | 'response' (vantage already applied)
 * @param {number} t - trace-relative ms
 * @param {Object} data - qlog h3 frame event data
 */
function handleH3Frame(model, side, t, data) {
    const sid = Number(data.stream_id);
    if (!Number.isFinite(sid)) return;
    const frame = data.frame;
    if (!frame || typeof frame !== 'object') return;
    const stream = getStream(model, sid);
    touchStream(stream, t);

    if (frame.frame_type === 'headers' && Array.isArray(frame.headers)) {
        if (side === 'request') {
            // First HEADERS wins — later ones on the same stream are trailers.
            if (stream.reqTime === null) {
                stream.reqTime = t;
                stream.reqHeaders = frame.headers;
            }
        } else {
            if (stream.respTime === null) stream.respTime = t;
            let status = null;
            for (const h of frame.headers) {
                if (h && h.name === ':status') {
                    const parsed = parseInt(h.value, 10);
                    if (isFinite(parsed)) status = parsed;
                    break;
                }
            }
            // Interim (1xx) responses are first-byte evidence but not the final status —
            // keep replacing until a >= 200 lands.
            if (stream.respStatus === null || stream.respStatus < 200) {
                stream.respHeaders = frame.headers;
                if (status !== null) stream.respStatus = status;
            }
        }
    }
}

/** States (across producers) that mean the QUIC handshake finished. */
const HANDSHAKE_COMPLETE_STATES = new Set(['handshake_complete', 'handshake_confirmed', 'confirmed']);

/**
 * Replay one decoded trace's events into a per-connection model: per-stream byte/timing
 * ledgers, handshake bounds, download packet sizes, and rtt/cwnd samples.
 * @param {Object} trace - raw trace from the decoder
 * @param {number} traceIndex - index across all inputs (fallback connection identity)
 * @returns {Promise<Object>} trace model
 */
async function buildTraceModel(trace, traceIndex) {
    const events = trace.events || [];
    const firstEventTime = events.length > 0 ? events[0].time : undefined;
    const clock = resolveClock(trace.commonFields, firstEventTime);
    const toRel = createTimeConverter(clock, firstEventTime);
    const isServer = !!(trace.vantagePoint && trace.vantagePoint.type === 'server');

    const cf = trace.commonFields || {};
    const odcid = (typeof cf.group_id === 'string' && cf.group_id)
        || (typeof cf.ODCID === 'string' && cf.ODCID)
        || (typeof cf.odcid === 'string' && cf.odcid)
        || `conn${traceIndex}`;

    const model = {
        odcid,
        vantagePoint: trace.vantagePoint || null,
        qlogVersion: trace.qlogVersion || '',
        qlogFormat: trace.qlogFormat || '',
        eventCount: events.length,
        clock,
        anchored: clock.anchored,
        anchorEpochMs: clock.anchorEpochMs,
        streams: new Map(),
        handshakeStart: null,
        handshakeDone: null,
        first1Rtt: null,
        rxPackets: [],
        rtt: [],
        cwnd: [],
        minRel: Infinity,
        maxRel: -Infinity
    };

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || ev.time === undefined || !ev.name) continue;
        const t = toRel(ev.time);
        if (!isFinite(t)) continue;
        if (t < model.minRel) model.minRel = t;
        if (t > model.maxRel) model.maxRel = t;
        const name = normalizeEventName(ev.name);
        const data = ev.data || {};

        switch (name) {
            case 'quic:packet_sent':
                handlePacket(model, isServer ? 's2c' : 'c2s', t, data);
                break;
            case 'quic:packet_received':
                handlePacket(model, isServer ? 'c2s' : 's2c', t, data);
                break;
            case 'http3:frame_created':
                // The local endpoint creates frames it SENDS: requests on a client
                // vantage, responses on a server vantage.
                handleH3Frame(model, isServer ? 'response' : 'request', t, data);
                break;
            case 'http3:frame_parsed':
                handleH3Frame(model, isServer ? 'request' : 'response', t, data);
                break;
            case 'http3:stream_type_set': {
                // Identifies stream roles (control/QPACK/push/...). Uni streams can never
                // pass the bidi id % 4 === 0 filter, so this is defense-in-depth for
                // producers that type bidi streams too — and the current draft's
                // H3StreamType includes "request" for request streams themselves, so only
                // a declared NON-request type may exclude. Field name is `stream_type` in
                // the spec; aioquic's 0.3-era events carry it as `new`.
                const sid = Number(data.stream_id);
                const streamType = data.stream_type !== undefined ? data.stream_type : data.new;
                if (Number.isFinite(sid) && typeof streamType === 'string' && streamType !== 'request') {
                    getStream(model, sid).excluded = true;
                }
                break;
            }
            case 'connectivity:connection_state_updated':
                if (HANDSHAKE_COMPLETE_STATES.has(data.new) && model.handshakeDone === null) {
                    model.handshakeDone = t;
                }
                break;
            // The current drafts folded the recovery namespace into quic:
            // (`quic:recovery_metrics_updated`, emitted by quiche); draft-0.3 producers
            // use `recovery:metrics_updated`. Same payload either way.
            case 'quic:recovery_metrics_updated':
            case 'recovery:metrics_updated': {
                const rtt = typeof data.latest_rtt === 'number' ? data.latest_rtt
                    : (typeof data.smoothed_rtt === 'number' ? data.smoothed_rtt : null);
                if (rtt !== null) model.rtt.push([t, rtt]);
                const cwnd = typeof data.congestion_window === 'number' ? data.congestion_window
                    : (typeof data.cwnd === 'number' ? data.cwnd : null);
                if (cwnd !== null) model.cwnd.push([t, cwnd]);
                break;
            }
            default:
                break;
        }

        // Keep the event loop responsive on 100k+ event captures.
        if (i > 0 && i % 20000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (model.minRel === Infinity) {
        model.minRel = 0;
        model.maxRel = 0;
    }
    return model;
}

/**
 * Peak download bandwidth (Kbps) via a 100ms sliding window over server→client packet
 * sizes, mirroring tcpdump's `calculateMaxBandwidth` (same window, same peak-pick).
 * @param {Array<{t: number, bytes: number}>} packets - times in page-relative ms
 * @returns {number} Kbps, 0 when there is not enough data
 */
function calculateMaxBandwidth(packets) {
    if (!packets || packets.length < 2) return 0;
    packets.sort((a, b) => a.t - b.t);

    const windowMs = 100;
    let maxBytesPerMs = 0;
    let windowStart = 0;
    let windowBytes = 0;

    for (let i = 0; i < packets.length; i++) {
        windowBytes += packets[i].bytes;
        while (packets[i].t - packets[windowStart].t > windowMs) {
            windowBytes -= packets[windowStart].bytes;
            windowStart++;
        }
        const elapsed = packets[i].t - packets[windowStart].t;
        if (elapsed > 1) { // avoid division by near-zero (mirrors tcpdump's 1ms guard)
            const bpms = windowBytes / elapsed;
            if (bpms > maxBytesPerMs) maxBytesPerMs = bpms;
        }
    }
    // bytes/ms * 8 = bits/ms = kilobits/second.
    return Math.round(maxBytesPerMs * 8);
}

/** Downsample a [[t, v], ...] series to at most maxPoints by stride sampling (always
 *  keeping the final sample so the series ends where the connection ended). */
function capSeries(series, maxPoints) {
    if (series.length <= maxPoints) return series;
    const stride = Math.ceil(series.length / maxPoints);
    const out = [];
    for (let i = 0; i < series.length; i += stride) out.push(series[i]);
    if (out[out.length - 1] !== series[series.length - 1]) out.push(series[series.length - 1]);
    return out;
}

/** Find a request header by (lowercased) name in an [{name, value}] list. */
function findHeader(headers, name) {
    if (!Array.isArray(headers)) return null;
    for (const h of headers) {
        if (h && typeof h.name === 'string' && h.name.toLowerCase() === name) return h;
    }
    return null;
}

/**
 * Build one Extended HAR entry from a per-stream ledger.
 * All `_` timing extensions are relative ms from page zero and only emitted when the
 * phase has actual evidence — missing is better than wrong.
 * @param {Object} stream - per-stream accumulator
 * @param {Object} model - owning trace model
 * @param {function(number): number} pageRel - trace-relative ms → page-relative ms
 * @param {number} pageEpochMs
 * @param {boolean} isConnectionOwner - earliest entry on the connection carries the handshake
 * @returns {Object} HAR entry
 */
function buildEntry(stream, model, pageRel, pageEpochMs, isConnectionOwner) {
    const rich = !!stream.reqHeaders;
    const odcid8 = model.odcid.substring(0, 8);

    // --- URL / method / status -------------------------------------------------------
    let method = 'GET';
    let url;
    if (rich) {
        const m = findHeader(stream.reqHeaders, ':method');
        if (m && m.value) method = m.value;
        const scheme = (findHeader(stream.reqHeaders, ':scheme') || {}).value || 'https';
        // A missing :authority (never seen in practice) degrades to the synthetic
        // connection host so har-export's http(s):// filter can't drop the entry.
        const authority = (findHeader(stream.reqHeaders, ':authority') || {}).value || `connection-${odcid8}`;
        const pathValue = (findHeader(stream.reqHeaders, ':path') || {}).value || '/';
        url = `${scheme}://${authority}${pathValue}`;
    } else {
        url = `https://connection-${odcid8}/stream-${stream.id}`;
    }

    const statusAssumed = stream.respStatus === null || stream.respStatus < 200;
    const status = statusAssumed ? 200 : stream.respStatus;

    const respContentType = rich ? (findHeader(stream.respHeaders, 'content-type') || {}).value : undefined;
    let contentLength;
    if (rich) {
        const cl = (findHeader(stream.respHeaders, 'content-length') || {}).value;
        const parsed = parseInt(cl, 10);
        if (isFinite(parsed) && parsed >= 0) contentLength = parsed;
    }

    // --- Phase timings (page-relative ms) ----------------------------------------------
    const firstTx = stream.tx.length > 0 ? stream.tx[0].t : null;
    const firstRx = stream.rx.length > 0 ? stream.rx[0].t : null;
    const lastTx = stream.tx.length > 0 ? stream.tx[stream.tx.length - 1].t : null;
    const lastRx = stream.rx.length > 0 ? stream.rx[stream.rx.length - 1].t : null;

    let created = pageRel(stream.firstT);
    // Request send time: the h3 HEADERS creation instant when instrumented, else the first
    // client→server STREAM frame; a stream with only rx evidence (never observed in
    // practice) degrades to its first activity so the bar still starts where proof exists.
    const loadStartT = stream.reqTime !== null ? stream.reqTime : (firstTx !== null ? firstTx : stream.firstT);
    const loadStart = pageRel(loadStartT);

    // First response evidence: the decoded h3 response HEADERS or the first server→client
    // STREAM frame — whichever the producer logged FIRST. frame_parsed fires after the
    // transport frame that carried it, so taking the h3 time unconditionally could put
    // ttfb after the download end of a single-packet response.
    let ttfbEndT;
    if (stream.respTime !== null && firstRx !== null) ttfbEndT = Math.min(stream.respTime, firstRx);
    else if (stream.respTime !== null) ttfbEndT = stream.respTime;
    else ttfbEndT = firstRx;
    const ttfbEnd = ttfbEndT !== null ? pageRel(ttfbEndT) : null;

    // Response completion: the fin-flagged rx frame when the producer logged it, else the
    // last rx frame observed (graceful degradation for truncated captures).
    let endRxT = null;
    for (let i = stream.rx.length - 1; i >= 0; i--) {
        if (stream.rx[i].fin) { endRxT = stream.rx[i].t; break; }
    }
    if (endRxT === null && lastRx !== null) endRxT = lastRx;
    const downloadEnd = endRxT !== null ? pageRel(endRxT) : null;

    let allEnd = loadStart;
    if (downloadEnd !== null && downloadEnd > allEnd) allEnd = downloadEnd;
    if (lastTx !== null && pageRel(lastTx) > allEnd) allEnd = pageRel(lastTx);

    // Connection setup spans (owner entry only). QUIC's handshake IS the TLS handshake,
    // so connect and ssl are the same interval — first packet to handshake confirmation
    // (HANDSHAKE_DONE received / state update / first 1RTT packet as fallback).
    let connectStart = null;
    let connectEnd = null;
    if (isConnectionOwner && model.handshakeStart !== null) {
        // Earliest completion signal wins: HANDSHAKE_DONE is a late CONFIRMATION that can
        // arrive AFTER the client already sent 1-RTT requests (observed in both curl and
        // aioquic samples) — and layout.js/har-export clamp request start to connectEnd,
        // so a late connectEnd would visually push the request later than the wire truth.
        // The first 1-RTT packet proves the handshake keys existed, which is when the
        // connection became usable for requests.
        let done = null;
        if (model.handshakeDone !== null) done = model.handshakeDone;
        if (model.first1Rtt !== null && (done === null || model.first1Rtt < done)) done = model.first1Rtt;
        if (done !== null && done >= model.handshakeStart) {
            connectStart = pageRel(model.handshakeStart);
            connectEnd = pageRel(done);
            // The request that triggered the connection was queued when the handshake
            // began — pull the queue start back so the connect/ssl bars sit inside the row.
            if (connectStart < created) created = connectStart;
        }
    }

    // --- Standard HAR timings (informational — the renderer uses the absolute `_` fields).
    // wait is derived so created + blocked + connect + wait lands exactly on ttfbEnd,
    // keeping har-converter's sequential first_data_time fallback on the wire truth.
    const connect = connectStart !== null ? round3(connectEnd - connectStart) : -1;
    const blocked = connectStart !== null
        ? round3(Math.max(0, connectStart - created))
        : round3(Math.max(0, loadStart - created));
    let wait = -1;
    let receive;
    if (ttfbEnd !== null) {
        wait = round3(Math.max(0, ttfbEnd - created - Math.max(0, blocked) - Math.max(0, connect)));
        receive = downloadEnd !== null ? round3(Math.max(0, downloadEnd - ttfbEnd)) : 0;
    } else {
        receive = round3(Math.max(0, allEnd - created - Math.max(0, blocked) - Math.max(0, connect)));
    }

    const entry = {
        startedDateTime: new Date(pageEpochMs + created).toISOString(),
        time: round3(Math.max(0, allEnd - created)),
        pageref: 'page_1',
        request: {
            method,
            url,
            httpVersion: 'HTTP/3',
            cookies: [],
            headers: rich ? stream.reqHeaders.map(h => ({ name: h.name, value: h.value })) : [],
            queryString: [],
            headersSize: -1,
            bodySize: -1
        },
        response: {
            status,
            statusText: '',
            httpVersion: 'HTTP/3',
            cookies: [],
            headers: (rich && stream.respHeaders) ? stream.respHeaders.map(h => ({ name: h.name, value: h.value })) : [],
            content: {
                size: contentLength !== undefined ? contentLength : stream.rxBytes,
                mimeType: respContentType || ''
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: stream.rxBytes > 0 ? stream.rxBytes : -1
        },
        cache: {},
        timings: { blocked, dns: -1, connect, ssl: connect, send: 0, wait, receive },
        connection: model.odcid
    };

    entry._full_url = url;
    entry._protocol = 'HTTP/3';
    if (statusAssumed) entry._statusAssumed = true;
    if (respContentType !== undefined) entry._contentType = respContentType;
    entry._stream_id = stream.id;

    if (stream.rxBytes > 0) entry._bytesIn = stream.rxBytes;
    if (stream.txBytes > 0) entry._bytesOut = stream.txBytes;
    if (contentLength !== undefined) entry._objectSize = contentLength;

    // RFC 9218 Extensible Priorities from the request `priority` header (u=N urgency).
    if (rich) {
        const pri = findHeader(stream.reqHeaders, 'priority');
        if (pri && typeof pri.value === 'string') {
            const match = pri.value.match(/u=(\d)/);
            if (match) entry._priority = priorityFromUrgency(parseInt(match[1], 10));
        }
    }

    // Absolute timing extensions (relative ms from page zero) — the renderer's
    // absolute-timings geometry path (layout.js hasAbsoluteTimings) consumes these.
    entry._created = round3(created);
    entry._all_start = round3(created);
    entry._all_end = round3(allEnd);
    entry._all_ms = round3(Math.max(0, allEnd - created));
    entry._load_start = round3(loadStart);
    entry._ttfb_start = round3(loadStart);
    if (ttfbEnd !== null) {
        entry._ttfb_end = round3(ttfbEnd);
        entry._download_start = round3(ttfbEnd);
        entry._ttfb_ms = round3(Math.max(0, ttfbEnd - loadStart));
    }
    if (downloadEnd !== null) {
        entry._download_end = round3(downloadEnd);
        entry._load_end = round3(downloadEnd);
        entry._load_ms = round3(Math.max(0, downloadEnd - loadStart));
    }
    if (connectStart !== null) {
        entry._connect_start = round3(connectStart);
        entry._connect_end = round3(connectEnd);
        // No separate TLS phase exists in QUIC — the handshake is TLS-integral, so the
        // ssl span mirrors the connect span by convention.
        entry._ssl_start = round3(connectStart);
        entry._ssl_end = round3(connectEnd);
    }
    // qlog carries no DNS events — never emit _dns_* (missing is better than wrong).

    // Byte-arrival chunks in the tcpdump convention: absolute ms timestamps
    // (pageEpochMs + relative), one chunk per packet (frames already coalesced per event).
    if (stream.rx.length > 0) {
        const chunks = [];
        for (const frame of stream.rx) {
            if (!(frame.bytes > 0)) continue;
            const ts = pageEpochMs + round3(pageRel(frame.t));
            const prev = chunks[chunks.length - 1];
            if (prev && prev.ts === ts) prev.bytes += frame.bytes;
            else chunks.push({ ts, bytes: frame.bytes });
        }
        if (chunks.length > 0) entry._chunks = chunks;
    }

    return entry;
}

/**
 * Build the Extended HAR `log` object from decoded qlog traces. Exported (rumcap
 * precedent) so the standalone CLI wrapper and tests can emit true Extended HAR without
 * routing through the `WaterfallTools` class.
 * @param {Array<Object>} rawTraces - decoder output ({qlogFormat, qlogVersion, vantagePoint, commonFields, events})
 * @param {Object} options - { debug }
 * @returns {Promise<Object>} Extended HAR log
 */
export async function buildQlogHarLog(rawTraces, options = {}) {
    const models = [];
    for (let i = 0; i < rawTraces.length; i++) {
        models.push(await buildTraceModel(rawTraces[i], i));
    }

    // --- Page zero resolution -----------------------------------------------------------
    // Anchored traces align by wall clock; page zero is the earliest anchored instant.
    // Unanchored traces anchor at page zero (their own first event = 0) and mark the page
    // clock as synthesized. All-unanchored captures synthesize the epoch entirely.
    let pageEpochMs = null;
    let clockSynthesized = false;
    for (const model of models) {
        if (model.anchored) {
            const startEpoch = model.anchorEpochMs + model.minRel;
            if (pageEpochMs === null || startEpoch < pageEpochMs) pageEpochMs = startEpoch;
        } else {
            clockSynthesized = true;
        }
    }
    if (pageEpochMs === null) {
        pageEpochMs = Date.now();
    }

    const pageRelFns = new Map();
    for (const model of models) {
        if (model.anchored) {
            const anchor = model.anchorEpochMs;
            pageRelFns.set(model, (t) => round3((anchor + t) - pageEpochMs));
        } else {
            const base = model.minRel;
            pageRelFns.set(model, (t) => round3(t - base));
        }
    }

    // --- Entries -------------------------------------------------------------------------
    const entries = [];
    for (const model of models) {
        const pageRel = pageRelFns.get(model);
        const candidates = [];
        for (const stream of model.streams.values()) {
            // Client-initiated bidirectional streams only (id % 4 === 0, RFC 9000 §2.1);
            // uni streams (control/QPACK) and streams with zero payload evidence are noise.
            if (stream.id % 4 !== 0) continue;
            if (stream.excluded) continue;
            if (!stream.reqHeaders && stream.txBytes === 0 && stream.rxBytes === 0) continue;
            candidates.push(stream);
        }
        candidates.sort((a, b) => (a.firstT - b.firstT) || (a.id - b.id));
        // Connection-owner convention: the earliest request on the connection carries the
        // handshake's connect/ssl spans; every later request rides the warm connection.
        for (let i = 0; i < candidates.length; i++) {
            entries.push(buildEntry(candidates[i], model, pageRel, pageEpochMs, i === 0));
        }
    }
    entries.sort((a, b) => (a._load_start - b._load_start) || (a._created - b._created));

    // --- Base page -------------------------------------------------------------------------
    // Earliest rich-mode request titles the page; degraded-only sets fall back to the
    // synthetic connection URL of the earliest stream.
    let baseEntry = null;
    for (const entry of entries) {
        // Rich mode is identifiable by the decoded h3 request headers; degraded entries
        // carry an empty request header list.
        if (entry.request.headers.length > 0) { baseEntry = entry; break; }
    }
    if (baseEntry) baseEntry._is_base_page = true;
    const pageTitle = baseEntry ? baseEntry.request.url : (entries.length > 0 ? entries[0].request.url : '');

    // --- Page -----------------------------------------------------------------------------
    const page = {
        id: 'page_1',
        title: pageTitle,
        startedDateTime: new Date(pageEpochMs).toISOString(),
        pageTimings: { onContentLoad: -1, onLoad: -1 }
    };
    if (clockSynthesized) page._clockSynthesized = true;

    // Download bandwidth peak across every connection (tcpdump-style 100ms window).
    const allRxPackets = [];
    for (const model of models) {
        const pageRel = pageRelFns.get(model);
        for (const p of model.rxPackets) allRxPackets.push({ t: pageRel(p.t), bytes: p.bytes });
    }
    const bwDown = calculateMaxBandwidth(allRxPackets);
    if (bwDown > 0) page._bwDown = bwDown;

    // Compact per-connection context for the details UI (small, JSON-safe).
    page._qlogTraces = models.map(model => ({
        vantagePoint: model.vantagePoint,
        odcid: model.odcid,
        qlogVersion: model.qlogVersion,
        format: model.qlogFormat,
        eventCount: model.eventCount,
        anchored: model.anchored
    }));

    // rtt / cwnd samples merged across connections, capped so the page object stays lean.
    const rtt = [];
    const cwnd = [];
    for (const model of models) {
        const pageRel = pageRelFns.get(model);
        for (const [t, v] of model.rtt) rtt.push([pageRel(t), round3(v)]);
        for (const [t, v] of model.cwnd) cwnd.push([pageRel(t), v]);
    }
    if (rtt.length > 0 || cwnd.length > 0) {
        rtt.sort((a, b) => a[0] - b[0]);
        cwnd.sort((a, b) => a[0] - b[0]);
        page._qlogMetrics = {
            rtt: capSeries(rtt, 300),
            cwnd: capSeries(cwnd, 300)
        };
    }

    const log = {
        version: '1.2',
        creator: { name: 'waterfall-tools (qlog)', version: VERSION },
        pages: [page],
        entries
    };

    if (options.debug) {
        console.log(`[qlog.js] Built HAR: ${models.length} connection(s), ${entries.length} entries`
            + ` (page epoch ${clockSynthesized ? 'synthesized' : new Date(pageEpochMs).toISOString()}).`);
    }

    return log;
}

/**
 * Node/browser processor for qlog captures (JSON-SEQ `.sqlog` and plain-JSON `.qlog`).
 * Accepts a file path, a Node Readable, a web ReadableStream, a raw buffer — or an ARRAY
 * of any of those for a multi-connection merge into one page. Detects an outer gzip layer
 * by magic bytes and inflates it before serialization sniffing.
 *
 * @param {string|ReadableStream|Uint8Array|ArrayBuffer|Array} input
 * @param {Object} options - { debug, onProgress, totalBytes }
 * @returns {Promise<Object>} relational waterfall data
 */
export async function processQlogNode(input, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const totalBytes = options.totalBytes || 0;

    // Isomorphic workaround for Node 22 Web Stream premature event loop exit bug
    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        const inputs = Array.isArray(input) ? input : [input];
        if (inputs.length === 0) throw new Error('No qlog inputs provided');

        const rawTraces = [];
        for (let i = 0; i < inputs.length; i++) {
            const bytes = await loadInputBytes(inputs[i], onProgress, inputs.length === 1 ? totalBytes : 0);
            onProgress('Parsing qlog...', 45 + Math.round(((i + 0.5) / inputs.length) * 35));
            const traces = await decodeQlogTraces(bytes, {
                debug: options.debug,
                onProgress: (fraction) => {
                    onProgress('Parsing qlog...', 45 + Math.round(((i + 0.5 * fraction) / inputs.length) * 35));
                }
            });
            if (options.debug) {
                console.log(`[qlog.js] Input ${i + 1}/${inputs.length}: ${traces.length} trace(s), `
                    + `${traces.reduce((sum, t) => sum + (t.events ? t.events.length : 0), 0)} event(s).`);
            }
            rawTraces.push(...traces);
        }

        if (rawTraces.length === 0) {
            throw new Error('No qlog traces found in input');
        }

        onProgress('Building waterfall...', 85);
        const log = await buildQlogHarLog(rawTraces, options);
        onProgress('Building waterfall...', 100);
        return buildWaterfallDataFromHar(log, 'qlog');
    } finally {
        if (keepAlive) globalThis.clearInterval(keepAlive);
    }
}
