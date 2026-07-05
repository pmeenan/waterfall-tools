/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview qlog serialization decoding utilities (isomorphic, pure).
 *
 * Handles the two qlog serializations found in the wild:
 *  1. JSON-SEQ (`.sqlog`, RFC 7464): 0x1E-prefixed, LF-terminated records. Record 1 is a
 *     header carrying `trace` metadata; every later record is a single event. Produced by
 *     curl/ngtcp2.
 *  2. Plain JSON (`.qlog`): `{qlog_format, qlog_version, traces: [{vantage_point,
 *     common_fields, events: [...]}]}`. Produced by aioquic. The events array can be
 *     enormous, so it is stream-parsed with @streamparser/json — never JSON.parse'd whole.
 *
 * Also owns event-namespace normalization (draft-0.3 `transport:`/`http:` vs current
 * `quic:`/`http3:` names) and clock-model resolution (relative/absolute/delta time formats,
 * number-or-object reference_time, and the absolute-epoch heuristic for producers like
 * aioquic that anchor implicitly).
 */
import { JSONParser } from '@streamparser/json';

/** RFC 7464 record separator that leads every JSON-SEQ record. */
const RECORD_SEPARATOR = 0x1e;

/**
 * The current IETF drafts renamed the two busiest draft-0.3 namespaces; everything else
 * (`recovery`, `connectivity`, `security`, `qpack`) kept its name. We normalize to the NEW
 * names internally so the parser only ever reasons about one canonical set.
 */
const NAMESPACE_RENAMES = {
    transport: 'quic',
    http: 'http3'
};

/**
 * Detect the JSON-SEQ serialization: the very first meaningful byte of an RFC 7464 stream
 * is the 0x1E record separator (a BOM or stray whitespace before it is tolerated for
 * robustness against hand-edited files).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isJsonSeq(bytes) {
    for (let i = 0; i < Math.min(bytes.length, 8); i++) {
        const b = bytes[i];
        if (b === RECORD_SEPARATOR) return true;
        // Skip UTF-8 BOM (EF BB BF) and ASCII whitespace; anything else decides "not SEQ".
        if (b === 0xef || b === 0xbb || b === 0xbf || b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
        return false;
    }
    return false;
}

/**
 * Normalize a qlog event name to the canonical `namespace:event` form using the current
 * IETF namespace names. Accepts both the `:` separator (spec) and the `.` separator some
 * producers historically emitted, and maps old-generation namespaces (`transport:` →
 * `quic:`, `http:` → `http3:`). Names without a separator pass through unchanged.
 * @param {string} name
 * @returns {string}
 */
export function normalizeEventName(name) {
    if (typeof name !== 'string') return '';
    // Split on the FIRST separator only — event names never nest, but future-proof against
    // dotted event suffixes by leaving everything after the namespace untouched.
    const sep = name.search(/[:.]/);
    if (sep === -1) return name;
    const ns = name.substring(0, sep);
    const event = name.substring(sep + 1).replace(/\./g, ':');
    const canonicalNs = NAMESPACE_RENAMES[ns] || ns;
    return `${canonicalNs}:${event}`;
}

/**
 * Liberal reference_time reader. Old drafts use a plain number (epoch ms; 0 means
 * "unanchored", NOT epoch-0 — see the netlog 1970 lesson), newer drafts allow an object
 * (`{clock_type, epoch, wall_clock_time}` with RFC3339 strings). Returns epoch ms or null
 * when no usable wall-clock anchor exists.
 * @param {number|string|Object|undefined} rt
 * @returns {number|null}
 */
export function parseReferenceTime(rt) {
    if (rt === undefined || rt === null) return null;
    if (typeof rt === 'number') return rt > 0 ? rt : null;
    if (typeof rt === 'string') {
        const n = Number(rt);
        if (isFinite(n)) return n > 0 ? n : null;
        const parsed = Date.parse(rt);
        return isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (typeof rt === 'object') {
        // wall_clock_time is the direct anchor; `epoch` is only usable when it is a real
        // RFC3339 date ("unknown" / "monotonic" epochs carry no wall-clock meaning).
        for (const field of ['wall_clock_time', 'epoch']) {
            const v = rt[field];
            if (typeof v === 'number' && v > 0) return v;
            if (typeof v === 'string' && v !== 'unknown') {
                const parsed = Date.parse(v);
                if (isFinite(parsed) && parsed > 0) return parsed;
            }
        }
    }
    return null;
}

/**
 * Resolve a trace's clock model from its common_fields plus the first event time.
 *
 * Resolution rules (verified against every producer in Sample/Data/qlog/):
 *  - reference_time present and truthy → anchored; event times are offsets from it.
 *  - No usable reference_time but event times look like epoch ms (> 1e12) → the producer
 *    (e.g. aioquic) logs absolute wall-clock times; anchored at the first event.
 *  - Otherwise unanchored (curl/ngtcp2's `reference_time: 0`) — the caller must synthesize
 *    a page epoch; NEVER treat these as epoch-0 (1970 dates poison downstream heuristics).
 *  - `time_format: "delta"` means each time is the delta from the previous event —
 *    `createTimeConverter` cumulative-sums it.
 *
 * @param {Object} commonFields - the trace's common_fields (may be undefined/empty)
 * @param {number|undefined} firstEventTime - raw `time` of the trace's first event
 * @returns {{timeFormat: string, referenceTimeMs: number|null, anchorEpochMs: number|null, anchored: boolean}}
 */
export function resolveClock(commonFields, firstEventTime) {
    const cf = commonFields || {};
    const referenceTimeMs = parseReferenceTime(cf.reference_time);
    let timeFormat = cf.time_format;

    // Absolute-epoch heuristic: with no anchor declared but times deep in epoch-ms range,
    // the times themselves ARE the anchor. Applied liberally (even over a declared
    // "relative") because a relative offset of 56,000+ years is not a real timeline.
    if (referenceTimeMs === null && typeof firstEventTime === 'number' && firstEventTime > 1e12) {
        timeFormat = 'absolute';
    } else if (timeFormat !== 'absolute' && timeFormat !== 'delta') {
        timeFormat = 'relative';
    }

    let anchorEpochMs = null;
    if (timeFormat === 'absolute') {
        // Absolute times anchor at the first event; a sub-1e12 "absolute" claim is bogus
        // (would render 1970 dates) so it degrades to unanchored while still rebasing.
        if (typeof firstEventTime === 'number' && firstEventTime > 1e12) {
            anchorEpochMs = firstEventTime;
        } else if (referenceTimeMs !== null) {
            anchorEpochMs = referenceTimeMs;
        }
    } else {
        anchorEpochMs = referenceTimeMs;
    }

    return {
        timeFormat,
        referenceTimeMs,
        anchorEpochMs,
        anchored: anchorEpochMs !== null
    };
}

/**
 * Build a stateful raw-event-time → trace-relative-ms converter for a resolved clock.
 * "Trace-relative" means: `anchorEpochMs + rel` is the wall-clock instant when the trace
 * is anchored; for unanchored traces rel is an arbitrary-origin monotonic offset the
 * caller rebases at merge time.
 * @param {{timeFormat: string}} clock - from resolveClock
 * @param {number|undefined} firstEventTime
 * @returns {function(number): number}
 */
export function createTimeConverter(clock, firstEventTime) {
    if (clock.timeFormat === 'delta') {
        // Each event time is the delta from the previous event; the first delta is from
        // the reference time (rel 0), so a plain running sum is exact.
        let cumulative = 0;
        return (t) => {
            cumulative += (typeof t === 'number' && isFinite(t)) ? t : 0;
            return cumulative;
        };
    }
    if (clock.timeFormat === 'absolute') {
        const base = typeof firstEventTime === 'number' ? firstEventTime : 0;
        return (t) => (typeof t === 'number' && isFinite(t)) ? t - base : 0;
    }
    return (t) => (typeof t === 'number' && isFinite(t)) ? t : 0;
}

/**
 * Parse a JSON-SEQ (RFC 7464) qlog byte stream into raw trace objects. Records are split
 * on the 0x1E separator (NOT on newlines — record payloads may legally contain them) and
 * parsed individually; malformed or truncated records are skipped so a partially-written
 * capture still yields every complete event before the corruption point.
 * @param {Uint8Array} bytes
 * @param {Object} [options] - { debug }
 * @returns {Array<Object>} raw traces: { qlogFormat, qlogVersion, vantagePoint, commonFields, title, events }
 */
export function parseJsonSeqTraces(bytes, options = {}) {
    const decoder = new TextDecoder('utf-8');
    const traces = [];
    let current = null;
    let skipped = 0;

    const startTrace = (header) => {
        // A header record carries the trace metadata under `trace` (single-trace form).
        const trace = (header && header.trace) || {};
        current = {
            qlogFormat: (header && (header.qlog_format || header.serialization_format)) || 'JSON-SEQ',
            // Spec-final files (quiche) drop qlog_version entirely and self-identify via
            // the file-schema URN — surface that so `_qlogTraces` stays informative.
            qlogVersion: (header && (header.qlog_version || header.file_schema)) || '',
            vantagePoint: trace.vantage_point || null,
            commonFields: trace.common_fields || {},
            title: trace.title,
            events: []
        };
        traces.push(current);
    };

    let recordStart = -1;
    for (let i = 0; i <= bytes.length; i++) {
        const atSeparator = i < bytes.length && bytes[i] === RECORD_SEPARATOR;
        if (!atSeparator && i < bytes.length) continue;
        if (recordStart >= 0 && i > recordStart) {
            const text = decoder.decode(bytes.subarray(recordStart, i));
            try {
                const record = JSON.parse(text);
                if (record && typeof record === 'object') {
                    if (record.qlog_version !== undefined || record.trace !== undefined) {
                        // Concatenated logs are legal in JSON-SEQ: every header record
                        // starts a fresh trace (fresh connection).
                        startTrace(record);
                    } else if (record.time !== undefined && record.name !== undefined) {
                        if (!current) startTrace(null); // headerless stream — be liberal
                        current.events.push(record);
                    }
                }
            } catch {
                skipped++; // truncated tail / corrupt record — keep everything before it
            }
        }
        recordStart = i + 1;
    }

    if (options.debug && skipped > 0) {
        console.log(`[qlog decoder] Skipped ${skipped} malformed JSON-SEQ record(s).`);
    }
    return traces;
}

/**
 * Stream-parse a plain-JSON qlog file into raw trace objects using @streamparser/json.
 * Only `qlog_format`, `qlog_version` and each `traces[i]` subtree are assembled — the
 * surrounding document text is never held as one string, keeping V8 clear of the
 * full-payload JSON.parse the house rules forbid.
 * @param {Uint8Array} bytes
 * @param {Object} [options] - { debug, onProgress }
 * @returns {Promise<Array<Object>>} raw traces (same shape as parseJsonSeqTraces)
 */
export async function parseJsonTraces(bytes, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const traces = [];
    let qlogFormat = 'JSON';
    let qlogVersion = '';

    const parser = new JSONParser({
        paths: ['$.qlog_version', '$.qlog_format', '$.file_schema', '$.serialization_format', '$.traces.*'],
        keepStack: false
    });

    parser.onValue = ({ value, key }) => {
        // Spec-final files self-identify via file_schema/serialization_format instead of
        // qlog_version/qlog_format — treat either pair as the version/format source
        // (qlog_version/qlog_format win when both appear).
        if (key === 'qlog_version' && typeof value === 'string') qlogVersion = value;
        else if (key === 'qlog_format' && typeof value === 'string') qlogFormat = value;
        else if (key === 'file_schema' && typeof value === 'string' && !qlogVersion) qlogVersion = value;
        else if (key === 'serialization_format' && typeof value === 'string' && qlogFormat === 'JSON') qlogFormat = value;
        else if (typeof key === 'number' && value && typeof value === 'object') {
            // A traces[] element. TraceError objects (no events) are listed but skipped.
            if (Array.isArray(value.events)) {
                traces.push({
                    qlogFormat: '', // patched below once the top-level scalars are known
                    qlogVersion: '',
                    vantagePoint: value.vantage_point || null,
                    commonFields: value.common_fields || {},
                    title: value.title,
                    events: value.events
                });
            }
        }
    };

    // Feed in slices so huge files keep the event loop responsive and report progress.
    const CHUNK = 256 * 1024;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        parser.write(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)));
        onProgress(Math.min(1, (offset + CHUNK) / bytes.length));
        if (bytes.length > CHUNK) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    // qlog_format/qlog_version may stream after traces[] depending on producer key order.
    for (const t of traces) {
        t.qlogFormat = qlogFormat;
        t.qlogVersion = qlogVersion;
    }

    if (options.debug) {
        console.log(`[qlog decoder] Parsed ${traces.length} trace(s) from plain-JSON qlog (version ${qlogVersion || 'unknown'}).`);
    }
    return traces;
}

/**
 * Decode a raw (already-gunzipped) qlog byte buffer into raw trace objects, auto-detecting
 * the serialization.
 * @param {Uint8Array} bytes
 * @param {Object} [options] - { debug, onProgress }
 * @returns {Promise<Array<Object>>}
 */
export async function decodeQlogTraces(bytes, options = {}) {
    if (isJsonSeq(bytes)) {
        return parseJsonSeqTraces(bytes, options);
    }
    return parseJsonTraces(bytes, options);
}
