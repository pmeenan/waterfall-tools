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
        
        this.leftover = null;
        this.firstEvent = true;
        this.debug = options.debug;
        
        // Emulated JSON payload stream
        let controllerRef = null;
        this.stream = new TransformStream({
            start: (controller) => {
                controllerRef = controller;
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
                }
            } else if (fR === 13 && wR === 0) { // sequence_flags
                const flR = readVarint(data, peekO);
                if ((Number(flR[0]) & 1) === 1) { // SEQ_INCREMENTAL_STATE_CLEARED
                    this.names.set(seqId, new Map());
                    this.categories.set(seqId, new Map());
                    this.debugNames.set(seqId, new Map());
                    this.seqTimestamps.set(seqId, 0);
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
    
    _parseTrackDescriptor(data, startOffset, len, seqNames) {
        const endOffset = startOffset + len;
        let o = startOffset;
        
        let uuid = 0n;
        let pid = 0;
        let tid = 0;
        let trackName = '';
        
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
            } else {
                o += this._skip(data, o, wire);
            }
        }
        
        this.tracks.set(uuid, { pid, tid, name: trackName });
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
                if (arg.name) trackEvent.args[arg.name] = arg.value;
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
                try { value = JSON.parse(jsonStr); } catch(e) { value = jsonStr; }
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
        
        let pid = 0;
        let tid = 0;
        if (event.track_uuid && this.tracks.has(event.track_uuid)) {
            const tk = this.tracks.get(event.track_uuid);
            pid = tk.pid;
            tid = tk.tid;
        }
        
        // Workaround for Chromium Perfetto grouping/interning bleeding:
        // Modern Chrome traces group network/render events into layout states (e.g. 'preFCP') 
        // entirely dropping the 'devtools.timeline' category requirement, and wrap dictionary 
        // arguments with corrupted pointers (like 'V8.SnapshotDecompress').
        const timelineEvents = new Set(['ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceReceivedData', 'ResourceFinish', 'EventDispatch', 'Layout', 'UpdateLayerTree', 'Paint', 'CompositeLayers', 'FunctionCall', 'EvaluateScript', 'v8.compile', 'ParseHTML']);
        
        if (timelineEvents.has(name)) {
             if (!cat.includes('devtools.timeline')) {
                 cat = cat ? cat + ',devtools.timeline' : 'devtools.timeline';
             }
             if (event.args && !event.args.data) {
                 const keys = Object.keys(event.args);
                 if (keys.length === 1 && typeof event.args[keys[0]] === 'object' && !Array.isArray(event.args[keys[0]])) {
                     event.args['data'] = event.args[keys[0]];
                     delete event.args[keys[0]];
                 }
             }
        }
        
        const jsonEvent = {
            cat, name, ph, ts: event.ts, pid, tid, args: event.args
        };
        
        if (event.id !== undefined) jsonEvent.id = event.id;
        if (event.id2 !== undefined) jsonEvent.id2 = event.id2;
        if (event.bind_id !== undefined) jsonEvent.bind_id = event.bind_id;
        
        if (jsonEvent.id === undefined && jsonEvent.id2 === undefined && event.track_uuid !== undefined) {
             jsonEvent.id2 = { local: "0x" + event.track_uuid.toString(16) };
        }
        
        const prefix = this.firstEvent ? '' : ',\n';
        this.firstEvent = false;
        controller.enqueue(prefix + JSON.stringify(jsonEvent));
    }
}
