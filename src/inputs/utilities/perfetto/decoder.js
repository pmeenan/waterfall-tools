/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * Lightweight, 100% Vanilla JS streaming Perfetto Protobuf decoder.
 * Reads binary track_event/interned_data packets and transforms them into
 * standard Chrome Trace format JSON payloads on the fly natively.
 */

// DevTools' trace handlers dispatch on event.name only and then dereference nested
// args paths without null-checking. Any event matching one of these names whose
// payload doesn't carry the listed path crashes the entire trace import with
// "Cannot read properties of undefined". The structured args usually live in
// Chrome-specific TrackEvent proto extensions (field numbers ≥ 9000 on the
// TrackEvent message itself, not in debug_annotations) — we don't decode those
// because each one needs its proto schema. Drop the events instead so the rest
// of the trace loads.
const DEVTOOLS_REQUIRED_ARG_PATHS = [
    // NetworkRequestsHandler — handler dereferences event.args.data.requestId on:
    { name: 'ResourceSendRequest', path: ['data', 'requestId'] },
    { name: 'ResourceWillSendRequest', path: ['data', 'requestId'] },
    { name: 'ResourceReceiveResponse', path: ['data', 'requestId'] },
    { name: 'ResourceReceivedData', path: ['data', 'requestId'] },
    { name: 'ResourceFinish', path: ['data', 'requestId'] },
    { name: 'ResourceMarkAsCached', path: ['data', 'requestId'] },
    { name: 'ResourceChangePriority', path: ['data', 'requestId'] },
    { name: 'PreloadRenderBlockingStatusChange', path: ['data', 'requestId'] },
    // MetaHandler.ts — event.args.render_frame_host.frame_type. Decoded as a typed
    // TrackEvent extension at field 1028 (see TRACK_EVENT_EXTENSION_SCHEMAS). Kept
    // in this list as a safety net: if the extension was somehow absent, drop the
    // event so DevTools doesn't crash dereferencing the missing field.
    { name: 'RenderFrameHostImpl::DidCommitSameDocumentNavigation', path: ['render_frame_host', 'frame_type'] },
    // MetaHandler / PageLoadMetricsHandler — event.args.context.performanceTimelineNavigationId
    { name: 'SoftNavigationStart', path: ['context', 'performanceTimelineNavigationId'] },
    // PageLoadMetricsHandler — event.args.args.total_blocking_time_ms (on InteractiveTime)
    { name: 'InteractiveTime', path: ['args', 'total_blocking_time_ms'] },
];
const DEVTOOLS_FRAGILE_NAMES = new Set(DEVTOOLS_REQUIRED_ARG_PATHS.map(r => r.name));
const DEVTOOLS_REQUIRED_ARG_PATH_BY_NAME = new Map(
    DEVTOOLS_REQUIRED_ARG_PATHS.map(r => [r.name, r.path])
);

// ChromeTrackEvent proto-extension schemas (Chromium base/tracing/protos/chrome_track_event.proto).
// Chrome attaches typed structured args to TrackEvent via proto extensions in the 1xxx
// field-number range. These are NOT debug_annotations and don't go through the generic
// debug-annotation path — they're top-level fields on TrackEvent that we'd skip blindly
// without a schema. Hardcoding the schema lets us emit Chrome's expected shape (frame_type
// as a string enum, nested process/site_instance/render_frame_host_id, etc.) so DevTools'
// MetaHandler can populate finalDisplayUrlByNavigationId properly instead of crashing.
//
// Schema shape (per field): { name: '<output-key>', type: 'message'|'string'|'uint'|'int'|'bool'|'enum',
//                              schema: <nested schema for messages>, enum: <number→string for enums> }
// Field 99 (debug_annotations) on each message is intentionally omitted — it would require
// the seqDebugNames context and isn't in DevTools' check path.
const FRAME_TYPE_ENUM = { 0: 'UNSPECIFIED_FRAME_TYPE', 1: 'SUBFRAME', 2: 'PRIMARY_MAIN_FRAME', 3: 'PRERENDER_MAIN_FRAME', 4: 'FENCED_FRAME_ROOT' };
const LIFECYCLE_STATE_ENUM = { 0: 'UNSPECIFIED', 1: 'SPECULATIVE', 2: 'PENDING_COMMIT', 3: 'PRERENDERING', 4: 'ACTIVE', 5: 'IN_BACK_FORWARD_CACHE', 6: 'RUNNING_UNLOAD_HANDLERS', 7: 'READY_TO_BE_DELETED' };
const SITE_INSTANCE_PROCESS_ASSIGNMENT_ENUM = { 0: 'UNKNOWN', 1: 'REUSED_EXISTING_PROCESS', 2: 'USED_SPARE_PROCESS', 3: 'CREATED_NEW_PROCESS' };

const SCHEMA_BROWSER_CONTEXT = {
    2: { name: 'id', type: 'string' },
};
const SCHEMA_RENDER_PROCESS_HOST = {
    1: { name: 'id', type: 'uint' },
    2: { name: 'process_lock', type: 'string' },
    3: { name: 'child_process_id', type: 'int' },
    4: { name: 'browser_context', type: 'message', schema: SCHEMA_BROWSER_CONTEXT },
};
const SCHEMA_GLOBAL_RFH_ID = {
    1: { name: 'routing_id', type: 'int' },
    2: { name: 'process_id', type: 'int' },
};
const SCHEMA_SITE_INSTANCE_GROUP = {
    1: { name: 'site_instance_group_id', type: 'int' },
    2: { name: 'active_frame_count', type: 'int' },
    3: { name: 'process', type: 'message', schema: SCHEMA_RENDER_PROCESS_HOST },
};
const SCHEMA_SITE_INSTANCE = {
    1: { name: 'site_instance_id', type: 'int' },
    2: { name: 'browsing_instance_id', type: 'int' },
    3: { name: 'is_default', type: 'bool' },
    4: { name: 'has_process', type: 'bool' },
    5: { name: 'related_active_contents_count', type: 'int' },
    6: { name: 'active_rfh_count', type: 'int' },
    7: { name: 'site_instance_group', type: 'message', schema: SCHEMA_SITE_INSTANCE_GROUP },
    8: { name: 'process_assignment', type: 'enum', enum: SITE_INSTANCE_PROCESS_ASSIGNMENT_ENUM },
};
const SCHEMA_BROWSING_CONTEXT_STATE = {
    1: { name: 'browsing_instance_id', type: 'int' },
    3: { name: 'coop_related_group_token', type: 'string' },
};
// RenderFrameHost is recursive (parent / outer_document / embedder fields). Defined as
// a placeholder object so child schemas can reference it before its full body is built.
const SCHEMA_RENDER_FRAME_HOST = {
    1: { name: 'process', type: 'message', schema: SCHEMA_RENDER_PROCESS_HOST },
    2: { name: 'render_frame_host_id', type: 'message', schema: SCHEMA_GLOBAL_RFH_ID },
    3: { name: 'lifecycle_state', type: 'enum', enum: LIFECYCLE_STATE_ENUM },
    4: { name: 'origin', type: 'string' },
    5: { name: 'url', type: 'string' },
    6: { name: 'frame_tree_node_id', type: 'uint' },
    7: { name: 'site_instance', type: 'message', schema: SCHEMA_SITE_INSTANCE },
    // 8/9/10 are recursive RenderFrameHost — wired below after the schema object exists.
    11: { name: 'browsing_context_state', type: 'message', schema: SCHEMA_BROWSING_CONTEXT_STATE },
    12: { name: 'frame_type', type: 'enum', enum: FRAME_TYPE_ENUM },
};
SCHEMA_RENDER_FRAME_HOST[8]  = { name: 'parent', type: 'message', schema: SCHEMA_RENDER_FRAME_HOST };
SCHEMA_RENDER_FRAME_HOST[9]  = { name: 'outer_document', type: 'message', schema: SCHEMA_RENDER_FRAME_HOST };
SCHEMA_RENDER_FRAME_HOST[10] = { name: 'embedder', type: 'message', schema: SCHEMA_RENDER_FRAME_HOST };

// TrackEvent extension field number → { name: <args-key>, schema: <RenderFrameHost-style schema> }
// Chromium reserves 1xxx for chrome extensions; we only map the ones DevTools actually reads.
// Add more here as new "Cannot read properties of undefined" crashes surface.
const TRACK_EVENT_EXTENSION_SCHEMAS = {
    1028: { name: 'render_frame_host', schema: SCHEMA_RENDER_FRAME_HOST },
};

// Sentinel thrown by the bounded readers below when a varint/length/fixed-width
// field would run past the end of its enclosing message. Caught per TracePacket
// in _parseTracePacket so one corrupt packet is skipped instead of aborting the
// whole stream.
const MALFORMED = new Error('Malformed Perfetto protobuf');

// Perfetto builtin clock ids (protos/perfetto/common/builtin_clock.proto).
const CLOCK_MONOTONIC = 3;
const CLOCK_BOOTTIME = 6;
// Clock ids 64..127 are sequence-scoped (only meaningful together with the
// trusted_packet_sequence_id they were defined on); ≥128 are global user clocks.
const SEQ_SCOPED_CLOCK_MIN = 64;
const SEQ_SCOPED_CLOCK_MAX = 127;

// A fast BigInt Varint decoder reading continuously from a Uint8Array.
// Returns an array [value (BigInt), bytesRead (Number)] or null if the varint
// doesn't terminate before `end` (or within the 10-byte varint maximum).
function readVarint(buf, offset, end = buf.length) {
    const limit = Math.min(end, buf.length, offset + 10);
    let val = 0n;
    let shift = 0n;
    let i = offset;
    while (i < limit) {
        const b = BigInt(buf[i++]);
        val |= (b & 0x7Fn) << shift;
        shift += 7n;
        if ((b & 0x80n) === 0n) {
            return [val, i - offset];
        }
    }
    return null;
}

// Bounded varint read: throws MALFORMED instead of returning null.
function rv(buf, offset, end) {
    const r = readVarint(buf, offset, end);
    if (!r) throw MALFORMED;
    return r;
}

// Bounded length-delimited header read: returns [payloadLen, headerBytes] and
// guarantees offset + headerBytes + payloadLen <= end.
function readLen(buf, offset, end) {
    const r = rv(buf, offset, end);
    const len = Number(r[0]);
    if (!Number.isSafeInteger(len) || len < 0 || offset + r[1] + len > end) throw MALFORMED;
    return [len, r[1]];
}

// Little-endian float64 at `offset`, bounded by `end`.
function readDouble(buf, offset, end) {
    if (offset + 8 > end || offset + 8 > buf.length) throw MALFORMED;
    return new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true);
}

export class PerfettoDecoder {
    /**
     * Initializes the TransformStream which takes Uint8Array buffers and outputs 
     * Stringified JSON chunks mapping directly to standard Extended HAR architectures.
     */
    constructor(options = {}) {
        this.categories = new Map();
        this.names = new Map();
        this.debugNames = new Map();
        this.tracks = new Map(); // uuid -> {pid, tid, name}
        // Per-sequence default track_uuid from TracePacketDefaults.track_event_defaults.
        // TrackEvents typically omit track_uuid and inherit this default — without it,
        // every event collapses to pid:0/tid:0 and downstream B/E pairing in Chrome
        // trace consumers (DevTools' TimelineModel) implodes since unrelated threads
        // pile onto the same stack.
        this.seqDefaultTracks = new Map();
        // Per-track B-event stacks. Perfetto's TYPE_SLICE_END events deliberately
        // omit name/categories (redundant with the matching B), but Chrome trace
        // JSON consumers like DevTools' RendererHandler.makeCompleteEvent reject
        // any E whose name/cat doesn't match the popped B verbatim — logging
        // "Begin/End events mismatch" hundreds of times. We push on B, pop on E,
        // and propagate name+cat onto E events that arrived empty.
        this.trackStacks = new Map();

        // ---- Clock model (https://perfetto.dev/docs/concepts/clock-sync) ----
        // Output timestamps are on the trace clock (BOOTTIME unless a ClockSnapshot
        // names a different primary_trace_clock), converted ns → integer µs. This
        // matches what Perfetto's own JSON exporter (traceconv) produces.
        this.traceClockId = CLOCK_BOOTTIME;
        // clockKey -> Map<clockKey, BigInt ns offset> (value_B = value_A + offset),
        // populated from the most recent ClockSnapshot containing both clocks.
        this.clockEdges = new Map();
        // clockKey -> BigInt offset to the trace clock (or null when unreachable).
        // Invalidated on every ClockSnapshot.
        this.clockOffsetCache = new Map();
        // clockKey -> { incremental, mult (BigInt ns per unit), last (BigInt raw | null) }
        this.clockInfo = new Map();
        // Per-sequence TracePacketDefaults.timestamp_clock_id.
        this.seqDefaultClock = new Map();
        // Per-sequence last resolved packet timestamp (µs, trace clock) — used for
        // packets that omit TracePacket.timestamp entirely.
        this.seqLastTsUs = new Map();
        // Per-sequence TrackEvent legacy timestamp_delta_us reference (raw µs in
        // the legacy MONOTONIC domain), seeded from ThreadDescriptor
        // .reference_timestamp_us and advanced by each delta.
        this.seqTrackEventRefUs = new Map();
        this.malformedPackets = 0;

        // Streaming reassembly state for TracePackets that span input chunks.
        this.pendingChunks = [];
        this.pendingBytes = 0;
        this.pendingNeeded = 0; // total bytes needed for the spanning packet (0 = header incomplete)
        this.firstEvent = true;
        this.debug = options.debug;
        // emitCompleteEvents: buffer Begins per-track and emit a single Complete (X)
        // event per matched pair on End. Required for DevTools' Performance panel —
        // its RendererHandler.makeCompleteEvent uses ONE global B/E stack across all
        // threads, so any cross-thread B/E pair that overlaps in ts order produces a
        // mismatch (DevTools dies with "Cannot read properties of null reading
        // requestId" when the resulting tree is malformed). X events bypass that
        // stack entirely and carry their own dur. Default off — the existing
        // chrome-trace.js consumer relies on the B/E parent-child stack semantics
        // for slice CPU aggregation, so we only opt-in for the DevTools path.
        this.emitCompleteEvents = options.emitCompleteEvents === true;
        
        // Emulated JSON payload stream
        this.stream = new TransformStream({
            start: (controller) => {
                controller.enqueue('{"traceEvents":[');
            },
            transform: (chunk, controller) => {
                this._processChunk(chunk, controller);
            },
            flush: (controller) => {
                if (this.debug && (this.pendingBytes > 0 || this.malformedPackets > 0)) {
                    console.log(`[perfetto decoder] ${this.malformedPackets} malformed packet(s) skipped, ${this.pendingBytes} trailing byte(s) discarded`);
                }
                this.pendingChunks = [];
                this.pendingBytes = 0;
                controller.enqueue(']}\n');
            }
        });
        
        const decoder = new TextDecoder('utf-8', { fatal: false });
        this.decodeString = (buf, offset, len) => decoder.decode(buf.subarray(offset, offset + len));
    }
    
    _processChunk(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
        let data;
        if (this.pendingChunks.length > 0) {
            // A TracePacket spans chunks. Accumulate without copying until enough
            // bytes have arrived to complete it, then concatenate once — re-copying
            // the leftover on every chunk is O(N²) for multi-MB packets.
            this.pendingChunks.push(chunk);
            this.pendingBytes += chunk.length;
            if (this.pendingNeeded > 0 && this.pendingBytes < this.pendingNeeded) return;
            data = new Uint8Array(this.pendingBytes);
            let off = 0;
            for (const c of this.pendingChunks) { data.set(c, off); off += c.length; }
            this.pendingChunks = [];
            this.pendingBytes = 0;
            this.pendingNeeded = 0;
        } else {
            data = chunk;
        }
        
        let o = 0;
        let needed = 0;
        while (o < data.length) {
            // Check for TracePacket (field 1, wireType 2 => 0x0A)
            const tagR = readVarint(data, o);
            if (!tagR) {
                // A varint can be at most 10 bytes; anything longer is corruption.
                if (data.length - o >= 10) { o += 1; continue; }
                break;
            }
            
            const field = Number(tagR[0] >> 3n);
            const wire = Number(tagR[0] & 7n);
            
            if (field === 1 && wire === 2) {
                const lenR = readVarint(data, o + tagR[1]);
                if (!lenR) {
                    if (data.length - o - tagR[1] >= 10) { o += 1; continue; }
                    break; // Not enough buffer for length
                }
                
                const packetLen = Number(lenR[0]);
                const headerLen = tagR[1] + lenR[1];
                if (!Number.isSafeInteger(packetLen) || packetLen < 0) {
                    o += 1;
                    continue;
                }
                
                if (o + headerLen + packetLen > data.length) {
                    // Packet incomplete, break and store leftover
                    needed = headerLen + packetLen;
                    break;
                }
                
                // Parse the fully available packet
                this._parseTracePacket(data, o + headerLen, packetLen, controller);
                o += headerLen + packetLen;
            } else {
                // If it's not a TracePacket, we try to skip it using wire type
                o += tagR[1];
                if (wire === 0) {
                    const v = readVarint(data, o);
                    if (!v) { o -= tagR[1]; break; }
                    o += v[1];
                } else if (wire === 1) {
                    if (o + 8 > data.length) { o -= tagR[1]; break; }
                    o += 8;
                } else if (wire === 5) {
                    if (o + 4 > data.length) { o -= tagR[1]; break; }
                    o += 4;
                } else if (wire === 2) {
                    const lV = readVarint(data, o);
                    if (!lV) {
                        if (data.length - o >= 10) { o -= tagR[1]; o += 1; continue; }
                        o -= tagR[1];
                        break;
                    }
                    const skipLen = Number(lV[0]);
                    if (!Number.isSafeInteger(skipLen) || skipLen < 0) {
                        o -= tagR[1];
                        o += 1;
                        continue;
                    }
                    if (o + lV[1] + skipLen > data.length) {
                        needed = tagR[1] + lV[1] + skipLen;
                        o -= tagR[1];
                        break;
                    }
                    o += lV[1] + skipLen;
                } else {
                    // Unknown wire type, fatal for streaming sync. Advance 1 byte and pray, or bail.
                    o -= tagR[1];
                    o += 1; 
                }
            }
        }
        
        if (o < data.length) {
            const rest = data.subarray(o);
            this.pendingChunks = [rest];
            this.pendingBytes = rest.length;
            this.pendingNeeded = needed;
        }
    }

    _parseTracePacket(data, startOffset, packetLen, controller) {
        try {
            this._parseTracePacketInner(data, startOffset, startOffset + packetLen, controller);
        } catch (e) {
            // Fail-soft: a corrupt inner length/varint skips this packet only.
            if (e !== MALFORMED && !(e instanceof RangeError)) throw e;
            this.malformedPackets++;
            if (this.debug) console.log(`[perfetto decoder] skipping malformed TracePacket at offset ${startOffset}: ${e.message}`);
        }
    }

    _resetSequence(seqId) {
        this.names.set(seqId, new Map());
        this.categories.set(seqId, new Map());
        this.debugNames.set(seqId, new Map());
        this.seqDefaultTracks.delete(seqId);
        this.seqDefaultClock.delete(seqId);
        this.seqTrackEventRefUs.delete(seqId);
        const prefix = `${seqId}:`;
        for (const [key, info] of this.clockInfo) {
            if (key.startsWith(prefix)) info.last = null;
        }
    }

    _parseTracePacketInner(data, startOffset, endOffset, controller) {
        // Pass 1: collect scalar fields and sub-message ranges. Field order inside a
        // TracePacket is not guaranteed (Chrome writes trusted_packet_sequence_id
        // after sequence_flags / trace_packet_defaults), so nothing is interpreted
        // until the whole packet has been scanned.
        let seqId = 0n; // Default ID if trusted_packet_sequence_id is missing
        let rawTs = null;
        let clockId = null;
        let cleared = false;
        let defaults = null;
        let snapshot = null;
        let threadDescriptor = null;
        let trackEventRange = null;
        const interned = [];
        const descriptors = [];

        let o = startOffset;
        while (o < endOffset) {
            const [tag, tagLen] = rv(data, o, endOffset);
            o += tagLen;
            const field = Number(tag >> 3n);
            const wire = Number(tag & 7n);

            if (wire === 0 && (field === 10 || field === 13 || field === 41 || field === 8 || field === 58)) {
                const [v, vLen] = rv(data, o, endOffset);
                o += vLen;
                if (field === 10) seqId = v;                                   // trusted_packet_sequence_id
                else if (field === 13) { if (v & 1n) cleared = true; }         // sequence_flags: SEQ_INCREMENTAL_STATE_CLEARED
                else if (field === 41) { if (v !== 0n) cleared = true; }       // incremental_state_cleared
                else if (field === 8) rawTs = v;                               // timestamp
                else clockId = Number(v);                                      // timestamp_clock_id
                continue;
            }
            if (wire === 2 && (field === 6 || field === 11 || field === 12 || field === 44 || field === 59 || field === 60)) {
                const [len, hLen] = readLen(data, o, endOffset);
                const range = { s: o + hLen, e: o + hLen + len };
                o = range.e;
                if (field === 12) interned.push(range);              // interned_data
                else if (field === 60) descriptors.push(range);      // track_descriptor
                else if (field === 59) defaults = range;             // trace_packet_defaults
                else if (field === 6) snapshot = range;              // clock_snapshot
                else if (field === 44) threadDescriptor = range;     // thread_descriptor (legacy)
                else trackEventRange = range;                        // track_event
                continue;
            }
            o += this._skip(data, o, wire, endOffset);
        }

        if (cleared) this._resetSequence(seqId);

        // Initialize maps for this sequence ID
        if (!this.names.has(seqId)) this.names.set(seqId, new Map());
        if (!this.categories.has(seqId)) this.categories.set(seqId, new Map());
        if (!this.debugNames.has(seqId)) this.debugNames.set(seqId, new Map());
        
        const seqNames = this.names.get(seqId);
        const seqCats = this.categories.get(seqId);
        const seqDebugNames = this.debugNames.get(seqId);

        // Pass 2: sequence state (defaults, interned data, descriptors, clocks)
        // before any timestamp or TrackEvent on this packet is interpreted.
        if (defaults) this._parseTracePacketDefaults(data, defaults.s, defaults.e, seqId);
        for (const r of interned) this._parseInternedData(data, r.s, r.e, seqNames, seqCats, seqDebugNames);
        for (const r of descriptors) this._parseTrackDescriptor(data, r.s, r.e, seqId);
        if (threadDescriptor) this._parseThreadDescriptor(data, threadDescriptor.s, threadDescriptor.e, seqId);

        if (snapshot) {
            // Mirrors trace_processor: a ClockSnapshot packet only (re)defines the
            // clock domains; its own timestamp does not advance incremental clocks.
            this._parseClockSnapshot(data, snapshot.s, snapshot.e, seqId);
            if (!trackEventRange) return;
        }

        // Every timestamped packet advances incremental clocks, even if it carries
        // no TrackEvent (descriptors, interned-data-only packets, ...).
        let packetUs;
        if (rawTs !== null) {
            packetUs = this._nsToUs(this._resolvePacketTimestampNs(seqId, rawTs, clockId));
            this.seqLastTsUs.set(seqId, packetUs);
        } else if (this.seqLastTsUs.has(seqId)) {
            packetUs = this.seqLastTsUs.get(seqId);
        } else if (this.seqTrackEventRefUs.has(seqId)) {
            packetUs = this._legacyUsToTraceUs(this.seqTrackEventRefUs.get(seqId));
        } else {
            packetUs = 0;
        }

        // Pass 3: the TrackEvent itself, using the updated sequence state.
        if (trackEventRange) {
            const trackEvent = this._parseTrackEvent(data, trackEventRange.s, trackEventRange.e - trackEventRange.s, seqNames, seqDebugNames, seqId, packetUs);
            this._emitTraceEvent(trackEvent, controller, seqNames, seqCats);
        }
    }

    // ---- Clock handling ----

    _clockKey(clockId, seqId) {
        if (clockId >= SEQ_SCOPED_CLOCK_MIN && clockId <= SEQ_SCOPED_CLOCK_MAX) return `${seqId}:${clockId}`;
        return `${clockId}`;
    }

    _nsToUs(ns) {
        // Integer µs (truncating), matching traceconv's JSON export.
        return Number(ns / 1000n);
    }

    // ClockSnapshot (TracePacket field 6):
    //   repeated Clock clocks = 1 { clock_id = 1, timestamp = 2, is_incremental = 3, unit_multiplier_ns = 4 }
    //   BuiltinClock primary_trace_clock = 2
    _parseClockSnapshot(data, start, end, seqId) {
        const clocks = [];
        let o = start;
        while (o < end) {
            const [tag, tagLen] = rv(data, o, end); o += tagLen;
            const field = Number(tag >> 3n);
            const wire = Number(tag & 7n);
            if (field === 1 && wire === 2) {
                const [len, hLen] = readLen(data, o, end);
                const cEnd = o + hLen + len;
                o += hLen;
                const clock = { id: 0, ts: 0n, incremental: false, mult: 1n };
                while (o < cEnd) {
                    const [ct, ctLen] = rv(data, o, cEnd); o += ctLen;
                    const cf = Number(ct >> 3n);
                    const cw = Number(ct & 7n);
                    if (cw === 0 && cf >= 1 && cf <= 4) {
                        const [v, vLen] = rv(data, o, cEnd); o += vLen;
                        if (cf === 1) clock.id = Number(v);
                        else if (cf === 2) clock.ts = v;
                        else if (cf === 3) clock.incremental = v !== 0n;
                        else if (v > 0n) clock.mult = v;
                    } else {
                        o += this._skip(data, o, cw, cEnd);
                    }
                }
                clocks.push(clock);
            } else if (field === 2 && wire === 0) {
                const [v, vLen] = rv(data, o, end); o += vLen;
                if (v !== 0n) this.traceClockId = Number(v);
            } else {
                o += this._skip(data, o, wire, end);
            }
        }

        const points = [];
        for (const c of clocks) {
            const key = this._clockKey(c.id, seqId);
            let info = this.clockInfo.get(key);
            if (!info) { info = { incremental: false, mult: 1n, last: null }; this.clockInfo.set(key, info); }
            info.incremental = c.incremental || (c.id >= SEQ_SCOPED_CLOCK_MIN && c.id <= SEQ_SCOPED_CLOCK_MAX);
            info.mult = c.mult;
            // The first packet after a snapshot is relative to the snapshot value.
            if (info.incremental) info.last = c.ts;
            points.push({ key, ns: c.ts * c.mult });
        }
        for (const a of points) {
            let edges = this.clockEdges.get(a.key);
            if (!edges) { edges = new Map(); this.clockEdges.set(a.key, edges); }
            for (const b of points) {
                if (a.key !== b.key) edges.set(b.key, b.ns - a.ns);
            }
        }
        this.clockOffsetCache.clear();
    }

    // BigInt ns offset converting a value on `key` to the trace clock, or null
    // when no chain of snapshots links the two domains. Uses the most recent
    // snapshot seen for each pair (streaming can't look ahead for a closer one).
    _clockOffset(key) {
        const target = `${this.traceClockId}`;
        if (key === target) return 0n;
        if (this.clockOffsetCache.has(key)) return this.clockOffsetCache.get(key);
        let result = null;
        const seen = new Set([key]);
        let frontier = [[key, 0n]];
        while (frontier.length > 0 && result === null) {
            const next = [];
            for (const [k, off] of frontier) {
                const edges = this.clockEdges.get(k);
                if (!edges) continue;
                for (const [k2, delta] of edges) {
                    if (seen.has(k2)) continue;
                    seen.add(k2);
                    if (k2 === target) { result = off + delta; break; }
                    next.push([k2, off + delta]);
                }
                if (result !== null) break;
            }
            frontier = next;
        }
        this.clockOffsetCache.set(key, result);
        return result;
    }

    // TracePacket.timestamp → BigInt ns on the trace clock. Clock selection:
    // packet timestamp_clock_id → sequence TracePacketDefaults.timestamp_clock_id
    // → trace clock. Incremental clocks accumulate per sequence.
    _resolvePacketTimestampNs(seqId, rawTs, clockId) {
        let cid = clockId;
        if (cid === null || cid === 0) cid = this.seqDefaultClock.has(seqId) ? this.seqDefaultClock.get(seqId) : this.traceClockId;
        const key = this._clockKey(cid, seqId);
        let info = this.clockInfo.get(key);
        if (!info && cid >= SEQ_SCOPED_CLOCK_MIN && cid <= SEQ_SCOPED_CLOCK_MAX) {
            const fallbackKey = `0:${cid}`;
            const fallback = seqId !== 0n ? this.clockInfo.get(fallbackKey) : null;
            if (fallback) {
                info = { incremental: fallback.incremental, mult: fallback.mult, last: fallback.last };
                this.clockInfo.set(key, info);
                const fbEdges = this.clockEdges.get(fallbackKey);
                if (fbEdges) {
                    this.clockEdges.set(key, new Map(fbEdges));
                    this.clockOffsetCache.clear();
                }
            } else {
                info = { incremental: true, mult: 1n, last: 0n };
                this.clockInfo.set(key, info);
            }
        }
        let valueNs;
        if (info && info.incremental) {
            const raw = (info.last === null ? 0n : info.last) + rawTs;
            info.last = raw;
            valueNs = raw * info.mult;
        } else {
            valueNs = rawTs * (info ? info.mult : 1n);
        }
        const off = this._clockOffset(key);
        return off === null ? valueNs : valueNs + off;
    }

    // Legacy TrackEvent µs timestamps (timestamp_delta_us / timestamp_absolute_us)
    // are in the MONOTONIC domain (Chrome's base::TimeTicks); trace_processor
    // converts them to trace time when a snapshot makes that possible.
    _legacyUsToTraceUs(us) {
        const off = this._clockOffset(`${CLOCK_MONOTONIC}`);
        if (off === null || off === 0n) return us;
        return this._nsToUs(BigInt(us) * 1000n + off);
    }

    _traceUsToLegacyUs(us) {
        const off = this._clockOffset(`${CLOCK_MONOTONIC}`);
        if (off === null || off === 0n) return us;
        return this._nsToUs(BigInt(us) * 1000n - off);
    }
    
    _parseInternedData(data, startOffset, endOffset, seqNames, seqCats, seqDebugNames) {
        let o = startOffset;
        while (o < endOffset) {
            const vR = rv(data, o, endOffset);
            o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            
            if (wire === 2 && (field === 1 || field === 2 || field === 3 || field === 6)) {
                const [innerLen, innerHdr] = readLen(data, o, endOffset);
                o += innerHdr;
                const innerEnd = o + innerLen;
                
                let iid = 0;
                let name = '';
                while (o < innerEnd) {
                    const eV = rv(data, o, innerEnd); o += eV[1];
                    const ef = Number(eV[0] >> 3n);
                    const ew = Number(eV[0] & 7n);
                    if (ef === 1 && ew === 0) {
                        const iidV = rv(data, o, innerEnd);
                        iid = Number(iidV[0]);
                        o += iidV[1];
                    } else if (ef === 2 && ew === 2) {
                        const [nlen, nHdr] = readLen(data, o, innerEnd);
                        o += nHdr;
                        name = this.decodeString(data, o, nlen);
                        o += nlen;
                    } else {
                        o += this._skip(data, o, ew, innerEnd);
                    }
                }
                
                if (field === 2) seqNames.set(iid, name);
                else if (field === 3 || field === 6) seqDebugNames.set(iid, name);
                else if (field === 1) seqCats.set(iid, name);
            } else {
                o += this._skip(data, o, wire, endOffset);
            }
        }
    }
    
    // TracePacket field 59 → TracePacketDefaults:
    //   timestamp_clock_id = 58 (or 1) — clock for every packet on this sequence that
    //     omits its own TracePacket.timestamp_clock_id (Chrome: incremental clock 64).
    //   track_event_defaults = 11 → track_uuid = 11 — implicit track that every
    //     TrackEvent on this sequence inherits when it omits its own track_uuid.
    // Chromium emits both on the first packet after each incremental-state reset.
    _parseTracePacketDefaults(data, startOffset, endOffset, seqId) {
        let o = startOffset;
        while (o < endOffset) {
            const vR = rv(data, o, endOffset); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            if ((field === 58 || field === 1) && wire === 0) { // timestamp_clock_id
                const cV = rv(data, o, endOffset); o += cV[1];
                this.seqDefaultClock.set(seqId, Number(cV[0]));
            } else if (field === 11 && wire === 2) { // track_event_defaults
                const [tedLen, tedHdr] = readLen(data, o, endOffset); o += tedHdr;
                const tedEnd = o + tedLen;
                while (o < tedEnd) {
                    const tV = rv(data, o, tedEnd); o += tV[1];
                    const tw = Number(tV[0] & 7n);
                    const tf = Number(tV[0] >> 3n);
                    if (tf === 11 && tw === 0) { // track_uuid
                        const uV = rv(data, o, tedEnd); o += uV[1];
                        this.seqDefaultTracks.set(seqId, uV[0]);
                    } else {
                        o += this._skip(data, o, tw, tedEnd);
                    }
                }
            } else {
                o += this._skip(data, o, wire, endOffset);
            }
        }
    }

    // ThreadDescriptor (TracePacket field 44, or TrackDescriptor field 4):
    //   pid = 1, tid = 2, reference_timestamp_us = 6. Returns { pid, tid } and
    //   records reference_timestamp_us as the sequence's delta_us reference.
    _parseThreadDescriptor(data, startOffset, endOffset, seqId) {
        let o = startOffset;
        let pid = 0;
        let tid = 0;
        while (o < endOffset) {
            const eV = rv(data, o, endOffset); o += eV[1];
            const ef = Number(eV[0] >> 3n);
            const ew = Number(eV[0] & 7n);
            if (ew === 0 && (ef === 1 || ef === 2 || ef === 6)) {
                const v = rv(data, o, endOffset); o += v[1];
                if (ef === 1) pid = Number(BigInt.asIntN(32, v[0]));
                else if (ef === 2) tid = Number(BigInt.asIntN(32, v[0]));
                else this.seqTrackEventRefUs.set(seqId, Number(BigInt.asIntN(64, v[0])));
            } else {
                o += this._skip(data, o, ew, endOffset);
            }
        }
        return { pid, tid };
    }

    _parseTrackDescriptor(data, startOffset, endOffset, seqId) {
        let o = startOffset;

        let uuid = 0n;
        let pid = 0;
        let tid = 0;
        let trackName = '';
        let hasThread = false;     // descriptor explicitly named a thread (pid+tid)
        let parentUuid = 0n;       // for async/named tracks that delegate pid resolution upward

        while (o < endOffset) {
            const vR = rv(data, o, endOffset); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);

            if (field === 1 && wire === 0) { // uuid
                const uV = rv(data, o, endOffset);
                uuid = uV[0];
                o += uV[1];
            } else if (field === 2 && wire === 2) { // name
                const [nLen, nHdr] = readLen(data, o, endOffset);
                o += nHdr;
                trackName = this.decodeString(data, o, nLen);
                o += nLen;
            } else if (field === 3 && wire === 2) { // process (pid)
                const [pLen, pHdr] = readLen(data, o, endOffset); o += pHdr;
                const pEnd = o + pLen;
                while (o < pEnd) {
                    const eV = rv(data, o, pEnd); o += eV[1];
                    if (Number(eV[0] >> 3n) === 1 && Number(eV[0] & 7n) === 0) {
                        const pidV = rv(data, o, pEnd);
                        pid = Number(pidV[0]);
                        o += pidV[1];
                    } else {
                        o += this._skip(data, o, Number(eV[0] & 7n), pEnd);
                    }
                }
            } else if (field === 4 && wire === 2) { // thread (pid/tid, reference_timestamp_us)
                const [tLen, tHdr] = readLen(data, o, endOffset); o += tHdr;
                const tEnd = o + tLen;
                hasThread = true;
                const t = this._parseThreadDescriptor(data, o, tEnd, seqId);
                pid = t.pid;
                tid = t.tid;
                o = tEnd;
            } else if (field === 5 && wire === 0) { // parent_uuid
                const pV = rv(data, o, endOffset);
                parentUuid = pV[0];
                o += pV[1];
            } else {
                o += this._skip(data, o, wire, endOffset);
            }
        }

        this.tracks.set(uuid, { pid, tid, name: trackName, hasThread, parentUuid });
    }

    // Async / named tracks usually carry only parent_uuid; pid lives on the
    // ancestor process descriptor. Walk up until we find a hasThread or a
    // pid-bearing track. Returns { pid, tid, hasThread }.
    _resolveTrack(uuid) {
        let cursor = this.tracks.get(uuid);
        let pid = cursor ? cursor.pid : 0;
        let tid = cursor ? cursor.tid : 0;
        let hasThread = !!(cursor && cursor.hasThread);
        let guard = 16;
        while (cursor && !hasThread && cursor.parentUuid && guard-- > 0) {
            cursor = this.tracks.get(cursor.parentUuid);
            if (!cursor) break;
            if (!pid && cursor.pid) pid = cursor.pid;
            if (cursor.hasThread) {
                pid = cursor.pid;
                tid = cursor.tid;
                hasThread = true;
                break;
            }
        }
        return { pid, tid, hasThread };
    }
    
    _parseTrackEvent(data, startOffset, len, seqNames, seqDebugNames, seqId, packetTs) {
        const endOffset = startOffset + len;
        let o = startOffset;
        
        const trackEvent = { args: {}, _categories: [], _categories_str: [] };
        let delta = null;
        let absTs = null;
        
        while (o < endOffset) {
            const vR = rv(data, o, endOffset); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            
            if (field === 1 && wire === 0) { // timestamp_delta_us
                const tV = rv(data, o, endOffset);
                o += tV[1];
                delta = Number(BigInt.asIntN(64, tV[0]));
            } else if (field === 16 && wire === 0) { // timestamp_absolute_us
                const tV = rv(data, o, endOffset);
                o += tV[1];
                absTs = Number(BigInt.asIntN(64, tV[0]));
            } else if (field === 3 && wire === 0) { // category_iid
                const cV = rv(data, o, endOffset);
                trackEvent._categories.push(Number(cV[0]));
                o += cV[1];
            } else if (field === 3 && wire === 2) { // packed category_iids
                const [pLen, pHdr] = readLen(data, o, endOffset); o += pHdr;
                const pEnd = o + pLen;
                while (o < pEnd) {
                    const cV = rv(data, o, pEnd);
                    trackEvent._categories.push(Number(cV[0]));
                    o += cV[1];
                }
            } else if (field === 22 && wire === 2) { // categories (string)
                const [cLen, cHdr] = readLen(data, o, endOffset); o += cHdr;
                trackEvent._categories_str.push(this.decodeString(data, o, cLen));
                o += cLen;
            } else if (field === 10 && wire === 0) { // name_iid
                const nV = rv(data, o, endOffset);
                trackEvent._name_iid = Number(nV[0]);
                o += nV[1];
            } else if (field === 23 && wire === 2) { // name
                const [nLen, nHdr] = readLen(data, o, endOffset); o += nHdr;
                trackEvent.name = this.decodeString(data, o, nLen);
                o += nLen;
            } else if (field === 9 && wire === 0) { // type (1: B, 2: E, 3: I)
                const tV = rv(data, o, endOffset);
                trackEvent.type = Number(tV[0]);
                o += tV[1];
            } else if (field === 11 && wire === 0) { // track_uuid
                const uV = rv(data, o, endOffset);
                trackEvent.track_uuid = uV[0];
                o += uV[1];
            } else if (field === 4 && wire === 2) { // debug_annotations
                const [dLen, dHdr] = readLen(data, o, endOffset); o += dHdr;
                const dEnd = o + dLen;
                const arg = this._parseDebugAnnotation(data, o, dEnd, seqDebugNames, seqNames);
                // Drop annotations with no parseable value. Perfetto producers
                // sometimes emit just a name (e.g. `data`) with no typed value field —
                // _parseDebugAnnotation returns value: null. Storing { data: null }
                // poisons downstream consumers (Chrome JSON traces never carry
                // args.data === null, and DevTools' NetworkRequestsHandler reads
                // event.args.data.requestId without null-checking).
                if (arg.name && arg.value !== null) trackEvent.args[arg.name] = arg.value;
                o = dEnd;
            } else if (field === 6 && wire === 2) { // legacy_event
                const [lLen, lHdr] = readLen(data, o, endOffset); o += lHdr;
                const lEnd = o + lLen;
                while (o < lEnd) {
                    const lV = rv(data, o, lEnd); o += lV[1];
                    const lw = Number(lV[0] & 7n); const lf = Number(lV[0] >> 3n);
                    if (lf === 2 && lw === 0) { // phase
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.legacyPhase = Number(v[0]);
                    } else if (lf === 3 && lw === 0) { // duration_us
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.legacyDurationUs = Number(BigInt.asIntN(64, v[0]));
                    } else if (lf === 6 && lw === 0) { // unscoped_id
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.id = v[0].toString(16);
                    } else if ((lf === 7 || lf === 10) && lw === 0) { // local_id (7 in old protos, 10 current)
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.id2 = { local: "0x" + v[0].toString(16) };
                    } else if (lf === 11 && lw === 0) { // global_id
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.id2 = { global: "0x" + v[0].toString(16) };
                    } else if (lf === 8 && lw === 0) { // bind_id
                        const v = rv(data, o, lEnd); o += v[1];
                        trackEvent.bind_id = "0x" + v[0].toString(16);
                    } else {
                        o += this._skip(data, o, lw, lEnd);
                    }
                }
            } else if (wire === 2 && TRACK_EVENT_EXTENSION_SCHEMAS[field] !== undefined) {
                // Chrome-specific TrackEvent proto extensions (field numbers ≥ 1000).
                // Decode using the hardcoded schema and merge into args under the
                // schema's named key — DevTools' MetaHandler reads args.render_frame_host
                // etc. directly, so the args shape needs to mirror Chrome's JSON output.
                const ext = TRACK_EVENT_EXTENSION_SCHEMAS[field];
                const [iLen, iHdr] = readLen(data, o, endOffset); o += iHdr;
                const innerEnd = o + iLen;
                trackEvent.args[ext.name] = this._parseSchemaMessage(data, o, innerEnd, ext.schema);
                o = innerEnd;
            } else {
                o += this._skip(data, o, wire, endOffset);
            }
        }

        if (absTs !== null) {
            this.seqTrackEventRefUs.set(seqId, absTs);
            trackEvent.ts = this._legacyUsToTraceUs(absTs);
        } else if (delta !== null) {
            const baseUs = this.seqTrackEventRefUs.has(seqId)
                ? this.seqTrackEventRefUs.get(seqId)
                : this._traceUsToLegacyUs(packetTs);
            const nextUs = baseUs + delta;
            this.seqTrackEventRefUs.set(seqId, nextUs);
            trackEvent.ts = this._legacyUsToTraceUs(nextUs);
        } else {
            trackEvent.ts = packetTs;
            if (packetTs > 0) {
                this.seqTrackEventRefUs.set(seqId, this._traceUsToLegacyUs(packetTs));
            }
        }

        // Inherit the sequence's default track when the event omits its own
        // track_uuid (the common case — Chromium only sets it on the rare
        // cross-thread event). Without this, every event collapses to pid:0/tid:0.
        if (trackEvent.track_uuid === undefined && this.seqDefaultTracks.has(seqId)) {
            trackEvent.track_uuid = this.seqDefaultTracks.get(seqId);
        }

        return trackEvent;
    }
    
    _parseDebugAnnotation(data, start, end, seqDebugNames, seqNames) {
        let o = start;
        let name = '';
        let value = null;
        let dict = null;
        let arr = null;
        
        while (o < end) {
            const aV = rv(data, o, end); o += aV[1];
            const aw = Number(aV[0] & 7n); const af = Number(aV[0] >> 3n);
            
            if (af === 1 && aw === 0) { // name_iid
                const nv = rv(data, o, end); o += nv[1];
                const iid = Number(nv[0]);
                name = seqDebugNames.get(iid) || seqNames.get(iid) || '';
            } else if (af === 10 && aw === 2) { // name
                const [nl, nHdr] = readLen(data, o, end); o += nHdr;
                name = this.decodeString(data, o, nl); o += nl;
            } else if (af === 2 && aw === 0) { // bool_value
                const bv = rv(data, o, end); o += bv[1]; value = bv[0] !== 0n;
            } else if (af === 3 && aw === 0) { // uint_value
                const uv = rv(data, o, end); o += uv[1]; value = Number(uv[0]);
            } else if (af === 4 && aw === 0) { // int_value
                const iv = rv(data, o, end); o += iv[1]; value = Number(BigInt.asIntN(64, iv[0]));
            } else if (af === 5 && aw === 1) { // double_value (64-bit float raw)
                value = readDouble(data, o, end);
                o += 8;
            } else if (af === 6 && aw === 2) { // string_value
                const [sl, sHdr] = readLen(data, o, end); o += sHdr;
                value = this.decodeString(data, o, sl); o += sl;
            } else if (af === 9 && aw === 2) { // legacy_json_value
                const [sl, sHdr] = readLen(data, o, end); o += sHdr;
                const jsonStr = this.decodeString(data, o, sl); o += sl;
                try { value = JSON.parse(jsonStr); } catch { value = jsonStr; }
            } else if (af === 8 && aw === 2) { // nested_value (recursive typed-value tree)
                // Chrome's standard mechanism for structured timeline args (frame ids,
                // pixel rects, dom node ids, etc. on PaintTimingVisualizer, LayoutShift,
                // EventTiming, NavStartToLargestContentfulPaint, ...). Distinct from
                // dict_entries — uses a separate NestedValue message with a typed-union
                // shape rather than recursive DebugAnnotation nesting.
                const [sl, sHdr] = readLen(data, o, end); o += sHdr;
                const innerEnd = o + sl;
                value = this._parseNestedValue(data, o, innerEnd);
                o = innerEnd;
            } else if (af === 11 && aw === 2) { // dict_entries
                if (!dict) dict = {};
                const [len, hLen] = readLen(data, o, end); o += hLen;
                const innerEnd = o + len;
                const entry = this._parseDebugAnnotation(data, o, innerEnd, seqDebugNames, seqNames);
                if (entry.name) dict[entry.name] = entry.value;
                o = innerEnd;
            } else if (af === 12 && aw === 2) { // array_values
                if (!arr) arr = [];
                const [len, hLen] = readLen(data, o, end); o += hLen;
                const innerEnd = o + len;
                const entry = this._parseDebugAnnotation(data, o, innerEnd, seqDebugNames, seqNames);
                arr.push(entry.value);
                o = innerEnd;
            } else {
                o += this._skip(data, o, aw, end);
            }
        }
        
        if (dict) value = dict;
        if (arr) value = arr;

        return { name, value };
    }

    // Perfetto NestedValue (debug_annotation.proto). Recursive typed-union tree:
    //   nested_type: UNSPECIFIED=0, DICT=1, ARRAY=2
    //   DICT  → parallel `dict_keys` (string) and `dict_values` (NestedValue) repeated
    //   ARRAY → repeated `array_values` (NestedValue)
    //   else  → exactly one of int/double/bool/string set
    _parseNestedValue(data, start, end) {
        let o = start;
        let nestedType = 0;
        const dictKeys = [];
        const dictValues = [];
        const arrayValues = [];
        let intVal, doubleVal, boolVal, stringVal;
        let scalarSeen = false;

        while (o < end) {
            const vR = rv(data, o, end); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);

            if (field === 1 && wire === 0) {        // nested_type
                const v = rv(data, o, end); o += v[1];
                nestedType = Number(v[0]);
            } else if (field === 2 && wire === 2) { // dict_keys (string)
                const [len, hLen] = readLen(data, o, end); o += hLen;
                dictKeys.push(this.decodeString(data, o, len));
                o += len;
            } else if (field === 3 && wire === 2) { // dict_values (NestedValue)
                const [len, hLen] = readLen(data, o, end); o += hLen;
                const innerEnd = o + len;
                dictValues.push(this._parseNestedValue(data, o, innerEnd));
                o = innerEnd;
            } else if (field === 4 && wire === 2) { // array_values (NestedValue)
                const [len, hLen] = readLen(data, o, end); o += hLen;
                const innerEnd = o + len;
                arrayValues.push(this._parseNestedValue(data, o, innerEnd));
                o = innerEnd;
            } else if (field === 5 && wire === 0) { // int_value
                const v = rv(data, o, end); o += v[1];
                intVal = Number(BigInt.asIntN(64, v[0]));
                scalarSeen = true;
            } else if (field === 6 && wire === 1) { // double_value
                doubleVal = readDouble(data, o, end);
                o += 8;
                scalarSeen = true;
            } else if (field === 7 && wire === 0) { // bool_value
                const v = rv(data, o, end); o += v[1];
                boolVal = v[0] !== 0n;
                scalarSeen = true;
            } else if (field === 8 && wire === 2) { // string_value
                const [len, hLen] = readLen(data, o, end); o += hLen;
                stringVal = this.decodeString(data, o, len);
                o += len;
                scalarSeen = true;
            } else {
                o += this._skip(data, o, wire, end);
            }
        }

        if (nestedType === 1 || (nestedType === 0 && dictKeys.length > 0)) {
            const dict = {};
            const n = Math.min(dictKeys.length, dictValues.length);
            for (let i = 0; i < n; i++) dict[dictKeys[i]] = dictValues[i];
            return dict;
        }
        if (nestedType === 2 || (nestedType === 0 && arrayValues.length > 0)) {
            return arrayValues;
        }
        if (boolVal !== undefined) return boolVal;
        if (stringVal !== undefined) return stringVal;
        if (doubleVal !== undefined) return doubleVal;
        if (intVal !== undefined) return intVal;
        return scalarSeen ? null : null;
    }

    // Schema-driven proto message decoder for Chrome TrackEvent extensions.
    // Walks the bytes [start, end) and emits a plain JS object whose keys come
    // from the provided schema (Chromium chrome_track_event.proto field map).
    // Unknown fields are skipped; mismatched wire types fall back to _skip.
    _parseSchemaMessage(data, start, end, schema) {
        const out = {};
        let o = start;
        while (o < end) {
            const tR = rv(data, o, end);
            o += tR[1];
            const wire = Number(tR[0] & 7n);
            const field = Number(tR[0] >> 3n);
            const def = schema[field];
            if (!def) { o += this._skip(data, o, wire, end); continue; }
            if (def.type === 'message' && wire === 2) {
                const [len, hLen] = readLen(data, o, end); o += hLen;
                const innerEnd = o + len;
                out[def.name] = this._parseSchemaMessage(data, o, innerEnd, def.schema);
                o = innerEnd;
            } else if (def.type === 'string' && wire === 2) {
                const [len, hLen] = readLen(data, o, end); o += hLen;
                out[def.name] = this.decodeString(data, o, len);
                o += len;
            } else if (def.type === 'uint' && wire === 0) {
                const v = rv(data, o, end); o += v[1];
                out[def.name] = Number(v[0]);
            } else if (def.type === 'int' && wire === 0) {
                const v = rv(data, o, end); o += v[1];
                out[def.name] = Number(BigInt.asIntN(64, v[0]));
            } else if (def.type === 'bool' && wire === 0) {
                const v = rv(data, o, end); o += v[1];
                out[def.name] = v[0] !== 0n;
            } else if (def.type === 'enum' && wire === 0) {
                const v = rv(data, o, end); o += v[1];
                const n = Number(v[0]);
                out[def.name] = def.enum[n] !== undefined ? def.enum[n] : n;
            } else {
                o += this._skip(data, o, wire, end);
            }
        }
        return out;
    }

    _skip(data, offset, wire, end = data.length) {
        if (wire === 0) return rv(data, offset, end)[1];
        if (wire === 1) {
            if (offset + 8 > end) throw MALFORMED;
            return 8;
        }
        if (wire === 5) {
            if (offset + 4 > end) throw MALFORMED;
            return 4;
        }
        if (wire === 2) {
            const [len, hLen] = readLen(data, offset, end);
            return hLen + len;
        }
        throw MALFORMED;
    }
    
    _emitTraceEvent(event, controller, seqNames, seqCats) {
        // Map Type. Legacy phases are char codes (e.g. complete 'X') and are valid
        // without TrackEvent.type.
        let ph = 'I';
        if (event.legacyPhase !== undefined) ph = String.fromCharCode(event.legacyPhase);
        else if (event.type === 1) ph = 'B';
        else if (event.type === 2) ph = 'E';
        else if (event.type === 3) ph = 'I';
        
        // Resolve categories natively concatenating strings
        let catArray = [];
        if (event._categories_str && event._categories_str.length > 0) {
            catArray = catArray.concat(event._categories_str);
        }
        if (event._categories && event._categories.length > 0) {
            catArray = catArray.concat(event._categories.map(iid => seqCats.get(iid) || '').filter(Boolean));
        }
        let cat = catArray.join(',');
        
        let name = event.name || seqNames.get(event._name_iid) || '';
        
        // Resolve (pid, tid). Real thread tracks emit their pid/tid directly; async
        // and named tracks usually only carry parent_uuid, so we walk up to find
        // an ancestor with a process or thread descriptor. For tracks that aren't
        // explicitly threads we synthesize a unique tid from the track's uuid —
        // otherwise every async track in a process collapses onto (pid, 0) and
        // DevTools' per-(pid,tid) B/E stack pairs unrelated slices together. The
        // 31-bit mask keeps the tid positive and well clear of real kernel TIDs
        // (which are typically < 100k while uuids are 64-bit pointer-shaped).
        let pid = 0;
        let tid = 0;
        if (event.track_uuid !== undefined && event.track_uuid !== 0n) {
            const r = this._resolveTrack(event.track_uuid);
            pid = r.pid;
            tid = r.hasThread ? r.tid : Number(event.track_uuid & 0x7FFFFFFFn);
        }

        // Per-track stack handling. Two modes:
        //   default — push {name, cat} on B, pop on E to copy name+cat onto E
        //             events that arrived empty (Perfetto omits them on TYPE_SLICE_END).
        //             Both B and E are emitted; consumer reconstructs nesting.
        //   emitCompleteEvents — buffer the entire Begin (don't emit), and on the
        //             matching E pop and emit a single X event with dur = E.ts - B.ts.
        //             This is what DevTools needs (its single global B/E stack can't
        //             handle cross-thread overlapping pairs).
        let pendingComplete = null;  // begin metadata to combine with this E into an X
        let suppressEmit = false;
        if (event.track_uuid !== undefined) {
            if (ph === 'B') {
                let stack = this.trackStacks.get(event.track_uuid);
                if (!stack) { stack = []; this.trackStacks.set(event.track_uuid, stack); }
                if (this.emitCompleteEvents) {
                    stack.push({
                        name, cat, ts: event.ts, pid, tid,
                        args: event.args,
                        id: event.id, id2: event.id2, bind_id: event.bind_id,
                    });
                    suppressEmit = true;  // wait for matching E
                } else {
                    stack.push({ name, cat });
                }
            } else if (ph === 'E') {
                const stack = this.trackStacks.get(event.track_uuid);
                if (stack && stack.length > 0) {
                    const top = stack.pop();
                    if (this.emitCompleteEvents) {
                        pendingComplete = top;
                    } else {
                        if (!name) name = top.name;
                        if (!cat) cat = top.cat;
                    }
                } else if (this.emitCompleteEvents) {
                    // Unbalanced E with no buffered B — drop. Emitting an orphan E
                    // would just put DevTools back into mismatch territory.
                    suppressEmit = true;
                }
            }
        }

        if (suppressEmit) return;

        // Workaround for Chromium Perfetto grouping/interning bleeding:
        // Modern Chrome traces group network/render events into layout states (e.g. 'preFCP')
        // entirely dropping the 'devtools.timeline' category requirement, and wrap dictionary
        // arguments with corrupted pointers (like 'V8.SnapshotDecompress').
        const timelineEvents = new Set(['ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceReceivedData', 'ResourceFinish', 'EventDispatch', 'Layout', 'UpdateLayerTree', 'Paint', 'CompositeLayers', 'FunctionCall', 'EvaluateScript', 'v8.compile', 'ParseHTML']);

        let outName = name;
        let outCat = cat;
        let outArgs = event.args;
        if (pendingComplete) {
            outName = pendingComplete.name;
            outCat = pendingComplete.cat;
            // Merge any non-empty args from this E onto the buffered B's args.
            outArgs = pendingComplete.args || {};
            if (event.args && Object.keys(event.args).length > 0) {
                outArgs = { ...(pendingComplete.args || {}), ...event.args };
            }
        }

        if (timelineEvents.has(outName)) {
             if (!outCat.includes('devtools.timeline')) {
                 outCat = outCat ? outCat + ',devtools.timeline' : 'devtools.timeline';
             }
             if (outArgs && !outArgs.data) {
                 const keys = Object.keys(outArgs);
                 // typeof null === 'object', so guard against mapping a null-valued
                 // debug annotation to args.data — that yields { data: null } and
                 // crashes DevTools' NetworkRequestsHandler when it does
                 // event.args.data.requestId.
                 if (keys.length === 1 && outArgs[keys[0]] !== null
                     && typeof outArgs[keys[0]] === 'object'
                     && !Array.isArray(outArgs[keys[0]])) {
                     outArgs = { data: outArgs[keys[0]] };
                 }
             }
        }

        // Defensive drop: DevTools handlers dispatch purely on event.name and
        // dereference nested args paths without null-checking. Drop any matching
        // event whose payload doesn't carry the required path — see the
        // DEVTOOLS_REQUIRED_ARG_PATHS list at the top of this file.
        if (DEVTOOLS_FRAGILE_NAMES.has(outName)) {
            const required = DEVTOOLS_REQUIRED_ARG_PATH_BY_NAME.get(outName);
            let cursor = outArgs;
            for (const key of required) {
                if (cursor === null || cursor === undefined || typeof cursor !== 'object') { cursor = undefined; break; }
                cursor = cursor[key];
            }
            if (cursor === undefined || cursor === null) return;
        }

        let jsonEvent;
        if (pendingComplete) {
            jsonEvent = {
                cat: outCat,
                name: outName,
                ph: 'X',
                ts: pendingComplete.ts,
                dur: Math.max(0, event.ts - pendingComplete.ts),
                pid: pendingComplete.pid,
                tid: pendingComplete.tid,
                args: outArgs,
            };
            if (pendingComplete.id !== undefined) jsonEvent.id = pendingComplete.id;
            if (pendingComplete.id2 !== undefined) jsonEvent.id2 = pendingComplete.id2;
            if (pendingComplete.bind_id !== undefined) jsonEvent.bind_id = pendingComplete.bind_id;
        } else {
            jsonEvent = {
                cat: outCat, name: outName, ph, ts: event.ts, pid, tid, args: outArgs,
            };
            if (ph === 'X' && event.legacyDurationUs !== undefined) {
                jsonEvent.dur = Math.max(0, event.legacyDurationUs);
            }
            if (event.id !== undefined) jsonEvent.id = event.id;
            if (event.id2 !== undefined) jsonEvent.id2 = event.id2;
            if (event.bind_id !== undefined) jsonEvent.bind_id = event.bind_id;
        }

        if (jsonEvent.id === undefined && jsonEvent.id2 === undefined && event.track_uuid !== undefined) {
             jsonEvent.id2 = { local: "0x" + event.track_uuid.toString(16) };
        }

        const prefix = this.firstEvent ? '' : ',\n';
        this.firstEvent = false;
        controller.enqueue(prefix + JSON.stringify(jsonEvent));
    }
}
