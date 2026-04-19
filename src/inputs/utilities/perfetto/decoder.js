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
// a `let` placeholder so child schemas can reference it before its full body is built.
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

// A fast BigInt Varint decoder reading continuously from a Uint8Array.
// Returns an array [value (BigInt), bytesRead (Number)] or null if buffer ends prematurely.
function readVarint(buf, offset) {
    let val = 0n;
    let shift = 0n;
    let i = offset;
    while (i < buf.length) {
        const b = BigInt(buf[i++]);
        val |= (b & 0x7Fn) << shift;
        shift += 7n;
        if ((b & 0x80n) === 0n) {
            return [val, i - offset];
        }
    }
    return null;
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
        this.seqTimestamps = new Map();
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

        this.leftover = null;
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
                controller.enqueue(']}\n');
            }
        });
        
        const decoder = new TextDecoder('utf-8', { fatal: false });
        this.decodeString = (buf, offset, len) => decoder.decode(buf.subarray(offset, offset + len));
    }
    
    _processChunk(chunk, controller) {
        let data;
        if (this.leftover) {
            data = new Uint8Array(this.leftover.length + chunk.length);
            data.set(this.leftover);
            data.set(chunk, this.leftover.length);
            this.leftover = null;
        } else {
            data = chunk;
        }
        
        let o = 0;
        while (o < data.length) {
            // Check for TracePacket (field 1, wireType 2 => 0x0A)
            const tagR = readVarint(data, o);
            if (!tagR) break;
            
            const field = Number(tagR[0] >> 3n);
            const wire = Number(tagR[0] & 7n);
            
            if (field === 1 && wire === 2) {
                const lenR = readVarint(data, o + tagR[1]);
                if (!lenR) break; // Not enough buffer for length
                
                const packetLen = Number(lenR[0]);
                const headerLen = tagR[1] + lenR[1];
                
                if (o + headerLen + packetLen > data.length) {
                    // Packet incomplete, break and store leftover
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
                    if (!lV || o + lV[1] + Number(lV[0]) > data.length) { o -= tagR[1]; break; }
                    o += lV[1] + Number(lV[0]);
                } else {
                    // Unknown wire type, fatal for streaming sync. Advance 1 byte and pray, or bail.
                    o -= tagR[1];
                    o += 1; 
                }
            }
        }
        
        if (o < data.length) {
            this.leftover = data.subarray(o);
        }
    }
    
    _parseTracePacket(data, startOffset, packetLen, controller) {
        const endOffset = startOffset + packetLen;
        let o = startOffset;
        let ts = 0;
        let trackEvent = null;
        let seqId = 0n; // Default ID if trusted_packet_sequence_id is missing

        let peekO = o;
        while (peekO < endOffset) {
            const vR = readVarint(data, peekO);
            if (!vR) break;
            const wR = Number(vR[0] & 7n);
            const fR = Number(vR[0] >> 3n);
            peekO += vR[1];
            
            if (fR === 10 && wR === 0) {
                const sR = readVarint(data, peekO);
                seqId = sR[0];
            } else if (fR === 41 && wR === 0) { // incremental_state_cleared
                const clR = readVarint(data, peekO);
                if (clR[0] !== 0n) {
                    this.names.set(seqId, new Map());
                    this.categories.set(seqId, new Map());
                    this.debugNames.set(seqId, new Map());
                    this.seqTimestamps.set(seqId, 0);
                    this.seqDefaultTracks.delete(seqId);
                }
            } else if (fR === 13 && wR === 0) { // sequence_flags
                const flR = readVarint(data, peekO);
                if ((Number(flR[0]) & 1) === 1) { // SEQ_INCREMENTAL_STATE_CLEARED
                    this.names.set(seqId, new Map());
                    this.categories.set(seqId, new Map());
                    this.debugNames.set(seqId, new Map());
                    this.seqTimestamps.set(seqId, 0);
                    this.seqDefaultTracks.delete(seqId);
                }
            } else if (fR === 8 && wR === 0) { // timestamp
                const tR = readVarint(data, peekO);
                ts = Number(tR[0]);
            }
            peekO += this._skip(data, peekO, wR);
        }

        // Initialize maps for this sequence ID
        if (!this.names.has(seqId)) this.names.set(seqId, new Map());
        if (!this.categories.has(seqId)) this.categories.set(seqId, new Map());
        if (!this.debugNames.has(seqId)) this.debugNames.set(seqId, new Map());
        
        const seqNames = this.names.get(seqId);
        const seqCats = this.categories.get(seqId);
        const seqDebugNames = this.debugNames.get(seqId);
        
        // Pass 2: Extract all interned data and descriptors beforehand protecting against serialization inversions
        peekO = o;
        while (peekO < endOffset) {
            const vR = readVarint(data, peekO);
            if (!vR) break;
            const wR = Number(vR[0] & 7n);
            const fR = Number(vR[0] >> 3n);
            peekO += vR[1];
            
            if (fR === 12 && wR === 2) { // interned_data
                const idLenR = readVarint(data, peekO);
                peekO += idLenR[1];
                this._parseInternedData(data, peekO, Number(idLenR[0]), seqNames, seqCats, seqDebugNames);
                peekO += Number(idLenR[0]);
            } else if (fR === 60 && wR === 2) { // track_descriptor
                const tdLenR = readVarint(data, peekO);
                peekO += tdLenR[1];
                this._parseTrackDescriptor(data, peekO, Number(tdLenR[0]), seqNames);
                peekO += Number(tdLenR[0]);
            } else if (fR === 59 && wR === 2) { // trace_packet_defaults
                const dLenR = readVarint(data, peekO);
                peekO += dLenR[1];
                this._parseTracePacketDefaults(data, peekO, Number(dLenR[0]), seqId);
                peekO += Number(dLenR[0]);
            } else {
                peekO += this._skip(data, peekO, wR);
            }
        }
        
        // Pass 3: Finally extract track events natively utilizing updated internal maps exclusively
        while (o < endOffset) {
            const vR = readVarint(data, o);
            if (!vR) break;
            o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            
            if (field === 11 && wire === 2) { // track_event
                const teLenR = readVarint(data, o);
                o += teLenR[1];
                trackEvent = this._parseTrackEvent(data, o, Number(teLenR[0]), seqNames, seqDebugNames, seqId, ts);
                o += Number(teLenR[0]);
            } else {
                o += this._skip(data, o, wire);
            }
        }
        
        if (trackEvent) {
            if (trackEvent.ts === undefined) trackEvent.ts = ts;
            this._emitTraceEvent(trackEvent, controller, seqNames, seqCats);
        }
    }
    
    _parseInternedData(data, startOffset, len, seqNames, seqCats, seqDebugNames) {
        const endOffset = startOffset + len;
        let o = startOffset;
        while (o < endOffset) {
            const vR = readVarint(data, o);
            o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            
            if (wire === 2 && (field === 1 || field === 2 || field === 3 || field === 6)) {
                const innerLenR = readVarint(data, o);
                o += innerLenR[1];
                const innerEnd = o + Number(innerLenR[0]);
                
                let iid = 0;
                let name = '';
                while (o < innerEnd) {
                    const eV = readVarint(data, o); o += eV[1];
                    const ef = Number(eV[0] >> 3n);
                    if (ef === 1) {
                        const iidV = readVarint(data, o);
                        iid = Number(iidV[0]);
                        o += iidV[1];
                    } else if (ef === 2 || (field === 6 && ef === 2)) {
                        const nLenV = readVarint(data, o);
                        const nlen = Number(nLenV[0]);
                        o += nLenV[1];
                        name = this.decodeString(data, o, nlen);
                        o += nlen;
                    } else {
                        o += this._skip(data, o, Number(eV[0] & 7n));
                    }
                }
                
                if (field === 2) seqNames.set(iid, name);
                else if (field === 3 || field === 6) seqDebugNames.set(iid, name);
                else if (field === 1) seqCats.set(iid, name);
            } else {
                o += this._skip(data, o, wire);
            }
        }
    }
    
    // TracePacket field 59 → TracePacketDefaults. The only field we care about is
    // track_event_defaults.track_uuid (field 11 inside field 11), which sets the
    // implicit track that every TrackEvent on this sequence inherits when it omits
    // its own track_uuid — Chromium emits it on the first packet after each
    // incremental_state_cleared boundary.
    _parseTracePacketDefaults(data, startOffset, len, seqId) {
        const endOffset = startOffset + len;
        let o = startOffset;
        while (o < endOffset) {
            const vR = readVarint(data, o); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            if (field === 11 && wire === 2) { // track_event_defaults
                const tedLenR = readVarint(data, o); o += tedLenR[1];
                const tedEnd = o + Number(tedLenR[0]);
                while (o < tedEnd) {
                    const tV = readVarint(data, o); o += tV[1];
                    const tw = Number(tV[0] & 7n);
                    const tf = Number(tV[0] >> 3n);
                    if (tf === 11 && tw === 0) { // track_uuid
                        const uV = readVarint(data, o); o += uV[1];
                        this.seqDefaultTracks.set(seqId, uV[0]);
                    } else {
                        o += this._skip(data, o, tw);
                    }
                }
            } else {
                o += this._skip(data, o, wire);
            }
        }
    }

    _parseTrackDescriptor(data, startOffset, len, _seqNames) {
        const endOffset = startOffset + len;
        let o = startOffset;

        let uuid = 0n;
        let pid = 0;
        let tid = 0;
        let trackName = '';
        let hasThread = false;     // descriptor explicitly named a thread (pid+tid)
        let parentUuid = 0n;       // for async/named tracks that delegate pid resolution upward

        while (o < endOffset) {
            const vR = readVarint(data, o); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);

            if (field === 1 && wire === 0) { // uuid
                const uV = readVarint(data, o);
                uuid = uV[0];
                o += uV[1];
            } else if (field === 2 && wire === 2) { // name
                const nLen = readVarint(data, o);
                o += nLen[1];
                trackName = this.decodeString(data, o, Number(nLen[0]));
                o += Number(nLen[0]);
            } else if (field === 3 && wire === 2) { // process (pid)
                const pLen = readVarint(data, o); o += pLen[1];
                const pEnd = o + Number(pLen[0]);
                while (o < pEnd) {
                    const eV = readVarint(data, o); o += eV[1];
                    if (Number(eV[0] >> 3n) === 1) {
                        const pidV = readVarint(data, o);
                        pid = Number(pidV[0]);
                        o += pidV[1];
                    } else {
                        o += this._skip(data, o, Number(eV[0] & 7n));
                    }
                }
            } else if (field === 4 && wire === 2) { // thread (pid/tid)
                const tLen = readVarint(data, o); o += tLen[1];
                const tEnd = o + Number(tLen[0]);
                hasThread = true;
                while (o < tEnd) {
                    const eV = readVarint(data, o); o += eV[1];
                    const ef = Number(eV[0] >> 3n);
                    if (ef === 1) { // pid
                        const pidV = readVarint(data, o);
                        pid = Number(pidV[0]);
                        o += pidV[1];
                    } else if (ef === 2) { // tid
                        const tidV = readVarint(data, o);
                        tid = Number(tidV[0]);
                        o += tidV[1];
                    } else {
                        o += this._skip(data, o, Number(eV[0] & 7n));
                    }
                }
            } else if (field === 5 && wire === 0) { // parent_uuid
                const pV = readVarint(data, o);
                parentUuid = pV[0];
                o += pV[1];
            } else {
                o += this._skip(data, o, wire);
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
            const vR = readVarint(data, o); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);
            
            if (field === 16 && wire === 0) { // timestamp_delta_us
                const tV = readVarint(data, o);
                o += tV[1];
                delta = Number(BigInt.asIntN(64, tV[0]));
            } else if (field === 17 && wire === 0) { // timestamp_absolute_us
                const tV = readVarint(data, o);
                o += tV[1];
                absTs = Number(BigInt.asIntN(64, tV[0]));
            } else if (field === 3 && wire === 0) { // category_iid
                const cV = readVarint(data, o);
                trackEvent._categories.push(Number(cV[0]));
                o += cV[1];
            } else if (field === 3 && wire === 2) { // packed category_iids
                const pLen = readVarint(data, o); o += pLen[1];
                const pEnd = o + Number(pLen[0]);
                while(o < pEnd) {
                    const cV = readVarint(data, o);
                    trackEvent._categories.push(Number(cV[0]));
                    o += cV[1];
                }
            } else if (field === 22 && wire === 2) { // categories (string)
                const cLen = readVarint(data, o); o += cLen[1];
                trackEvent._categories_str.push(this.decodeString(data, o, Number(cLen[0])));
                o += Number(cLen[0]);
            } else if (field === 10 && wire === 0) { // name_iid
                const nV = readVarint(data, o);
                trackEvent._name_iid = Number(nV[0]);
                o += nV[1];
            } else if (field === 23 && wire === 2) { // name
                const nLen = readVarint(data, o); o += nLen[1];
                trackEvent.name = this.decodeString(data, o, Number(nLen[0]));
                o += Number(nLen[0]);
            } else if (field === 9 && wire === 0) { // type (1: B, 2: E, 3: I)
                const tV = readVarint(data, o);
                trackEvent.type = Number(tV[0]);
                o += tV[1];
            } else if (field === 11 && wire === 0) { // track_uuid
                const uV = readVarint(data, o);
                trackEvent.track_uuid = uV[0];
                o += uV[1];
            } else if (field === 4 && wire === 2) { // debug_annotations
                const dLen = readVarint(data, o); o += dLen[1];
                const dEnd = o + Number(dLen[0]);
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
                const lLen = readVarint(data, o); o += lLen[1];
                const lEnd = o + Number(lLen[0]);
                while (o < lEnd) {
                    const lV = readVarint(data, o); o += lV[1];
                    const lw = Number(lV[0] & 7n); const lf = Number(lV[0] >> 3n);
                    if (lf === 6 && lw === 0) { // unscoped_id
                        const v = readVarint(data, o); o += v[1];
                        trackEvent.id = v[0].toString(16);
                    } else if (lf === 7 && lw === 0) { // local_id
                        const v = readVarint(data, o); o += v[1];
                        trackEvent.id2 = { local: "0x" + v[0].toString(16) };
                    } else if (lf === 8 && lw === 0) { // global_id
                        const v = readVarint(data, o); o += v[1];
                        trackEvent.id2 = { global: "0x" + v[0].toString(16) };
                    } else if (lf === 11 && lw === 0) { // bind_id
                        const v = readVarint(data, o); o += v[1];
                        trackEvent.bind_id = "0x" + v[0].toString(16);
                    } else {
                        o += this._skip(data, o, lw);
                    }
                }
            } else if (wire === 2 && TRACK_EVENT_EXTENSION_SCHEMAS[field] !== undefined) {
                // Chrome-specific TrackEvent proto extensions (field numbers ≥ 1000).
                // Decode using the hardcoded schema and merge into args under the
                // schema's named key — DevTools' MetaHandler reads args.render_frame_host
                // etc. directly, so the args shape needs to mirror Chrome's JSON output.
                const ext = TRACK_EVENT_EXTENSION_SCHEMAS[field];
                const lR = readVarint(data, o); o += lR[1];
                const innerEnd = o + Number(lR[0]);
                trackEvent.args[ext.name] = this._parseSchemaMessage(data, o, innerEnd, ext.schema);
                o = innerEnd;
            } else {
                o += this._skip(data, o, wire);
            }
        }

        let currentTs = this.seqTimestamps.get(seqId) || 0;
        
        if (absTs !== null) {
            currentTs = absTs;
            this.seqTimestamps.set(seqId, currentTs);
        } else if (delta !== null) {
            if (currentTs === 0 && packetTs > 0) {
                currentTs = packetTs;
            }
            currentTs += delta;
            this.seqTimestamps.set(seqId, currentTs);
        } else {
            if (packetTs > 0 && currentTs === 0) {
                currentTs = packetTs;
            }
            this.seqTimestamps.set(seqId, currentTs);
        }
        
        trackEvent.ts = currentTs;

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
            const aV = readVarint(data, o); o += aV[1];
            const aw = Number(aV[0] & 7n); const af = Number(aV[0] >> 3n);
            
            if (af === 1 && aw === 0) { // name_iid
                const nv = readVarint(data, o); o+=nv[1];
                const iid = Number(nv[0]);
                name = seqDebugNames.get(iid) || seqNames.get(iid) || '';
            } else if (af === 10 && aw === 2) { // name
                const nl = readVarint(data, o); o+=nl[1];
                name = this.decodeString(data, o, Number(nl[0])); o+=Number(nl[0]);
            } else if (af === 2 && aw === 0) { // bool_value
                const bv = readVarint(data, o); o+=bv[1]; value = bv[0] !== 0n;
            } else if (af === 3 && aw === 0) { // uint_value
                const uv = readVarint(data, o); o+=uv[1]; value = Number(uv[0]);
            } else if (af === 4 && aw === 0) { // int_value
                const iv = readVarint(data, o); o+=iv[1]; value = Number(iv[0]);
            } else if (af === 5 && aw === 1) { // double_value (64-bit float raw)
                const view = new DataView(data.buffer, data.byteOffset + o, 8); 
                value = view.getFloat64(0, true); 
                o+=8;
            } else if (af === 6 && aw === 2) { // string_value
                const sl = readVarint(data, o); o+=sl[1];
                value = this.decodeString(data, o, Number(sl[0])); o+=Number(sl[0]);
            } else if (af === 9 && aw === 2) { // legacy_json_value
                const sl = readVarint(data, o); o+=sl[1];
                const jsonStr = this.decodeString(data, o, Number(sl[0])); o+=Number(sl[0]);
                try { value = JSON.parse(jsonStr); } catch { value = jsonStr; }
            } else if (af === 8 && aw === 2) { // nested_value (recursive typed-value tree)
                // Chrome's standard mechanism for structured timeline args (frame ids,
                // pixel rects, dom node ids, etc. on PaintTimingVisualizer, LayoutShift,
                // EventTiming, NavStartToLargestContentfulPaint, ...). Distinct from
                // dict_entries — uses a separate NestedValue message with a typed-union
                // shape rather than recursive DebugAnnotation nesting.
                const sl = readVarint(data, o); o+=sl[1];
                const innerEnd = o + Number(sl[0]);
                value = this._parseNestedValue(data, o, innerEnd);
                o = innerEnd;
            } else if (af === 11 && aw === 2) { // dict_entries
                if (!dict) dict = {};
                const lenR = readVarint(data, o); o += lenR[1];
                const innerEnd = o + Number(lenR[0]);
                const entry = this._parseDebugAnnotation(data, o, innerEnd, seqDebugNames, seqNames);
                if (entry.name) dict[entry.name] = entry.value;
                o = innerEnd;
            } else if (af === 12 && aw === 2) { // array_values
                if (!arr) arr = [];
                const lenR = readVarint(data, o); o += lenR[1];
                const innerEnd = o + Number(lenR[0]);
                const entry = this._parseDebugAnnotation(data, o, innerEnd, seqDebugNames, seqNames);
                arr.push(entry.value);
                o = innerEnd;
            } else {
                o += this._skip(data, o, aw);
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
            const vR = readVarint(data, o); o += vR[1];
            const wire = Number(vR[0] & 7n);
            const field = Number(vR[0] >> 3n);

            if (field === 1 && wire === 0) {        // nested_type
                const v = readVarint(data, o); o += v[1];
                nestedType = Number(v[0]);
            } else if (field === 2 && wire === 2) { // dict_keys (string)
                const lR = readVarint(data, o); o += lR[1];
                dictKeys.push(this.decodeString(data, o, Number(lR[0])));
                o += Number(lR[0]);
            } else if (field === 3 && wire === 2) { // dict_values (NestedValue)
                const lR = readVarint(data, o); o += lR[1];
                const innerEnd = o + Number(lR[0]);
                dictValues.push(this._parseNestedValue(data, o, innerEnd));
                o = innerEnd;
            } else if (field === 4 && wire === 2) { // array_values (NestedValue)
                const lR = readVarint(data, o); o += lR[1];
                const innerEnd = o + Number(lR[0]);
                arrayValues.push(this._parseNestedValue(data, o, innerEnd));
                o = innerEnd;
            } else if (field === 5 && wire === 0) { // int_value
                const v = readVarint(data, o); o += v[1];
                intVal = Number(BigInt.asIntN(64, v[0]));
                scalarSeen = true;
            } else if (field === 6 && wire === 1) { // double_value
                const view = new DataView(data.buffer, data.byteOffset + o, 8);
                doubleVal = view.getFloat64(0, true);
                o += 8;
                scalarSeen = true;
            } else if (field === 7 && wire === 0) { // bool_value
                const v = readVarint(data, o); o += v[1];
                boolVal = v[0] !== 0n;
                scalarSeen = true;
            } else if (field === 8 && wire === 2) { // string_value
                const lR = readVarint(data, o); o += lR[1];
                stringVal = this.decodeString(data, o, Number(lR[0]));
                o += Number(lR[0]);
                scalarSeen = true;
            } else {
                o += this._skip(data, o, wire);
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
            const tR = readVarint(data, o); if (!tR) break;
            o += tR[1];
            const wire = Number(tR[0] & 7n);
            const field = Number(tR[0] >> 3n);
            const def = schema[field];
            if (!def) { o += this._skip(data, o, wire); continue; }
            if (def.type === 'message' && wire === 2) {
                const lR = readVarint(data, o); o += lR[1];
                const innerEnd = o + Number(lR[0]);
                out[def.name] = this._parseSchemaMessage(data, o, innerEnd, def.schema);
                o = innerEnd;
            } else if (def.type === 'string' && wire === 2) {
                const lR = readVarint(data, o); o += lR[1];
                out[def.name] = this.decodeString(data, o, Number(lR[0]));
                o += Number(lR[0]);
            } else if (def.type === 'uint' && wire === 0) {
                const v = readVarint(data, o); o += v[1];
                out[def.name] = Number(v[0]);
            } else if (def.type === 'int' && wire === 0) {
                const v = readVarint(data, o); o += v[1];
                out[def.name] = Number(BigInt.asIntN(64, v[0]));
            } else if (def.type === 'bool' && wire === 0) {
                const v = readVarint(data, o); o += v[1];
                out[def.name] = v[0] !== 0n;
            } else if (def.type === 'enum' && wire === 0) {
                const v = readVarint(data, o); o += v[1];
                const n = Number(v[0]);
                out[def.name] = def.enum[n] !== undefined ? def.enum[n] : n;
            } else {
                o += this._skip(data, o, wire);
            }
        }
        return out;
    }

    _skip(data, offset, wire) {
        if (wire === 0) return readVarint(data, offset)[1];
        if (wire === 1) return 8;
        if (wire === 5) return 4;
        if (wire === 2) {
            const v = readVarint(data, offset);
            return v[1] + Number(v[0]);
        }
        return 0;
    }
    
    _emitTraceEvent(event, controller, seqNames, seqCats) {
        // Map Type
        let ph = 'I';
        if (event.type === 1) ph = 'B';
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
