/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { QuicBuffer } from './quic-buffer.js';
import { QpackDecoder } from './qpack-decoder.js';

export function decodeHttp3(quicStreams) {
    // QPACK Requires two distinct dynamic tables (RFC 9204)
    const qpackClientDec = new QpackDecoder();
    const qpackServerDec = new QpackDecoder();

    // Assembles contiguous stream fragments into a single buffer while tracking
    // the capture timestamp of each contributing fragment range.
    // Returns { buffer, startOffset, segments, timeAt, sliceChunks }.
    const assemble = (frags) => {
        if (!frags || frags.length === 0) return undefined;
        // Start from the first available fragment's offset instead of requiring offset 0.
        // This allows partial assembly of streams that began before the capture started.
        let offset = frags[0].offset;
        const startOffset = offset;
        const blocks = [];
        const blockTimes = [];
        for (const f of frags) {
            if (f.offset === offset) {
                blocks.push(f.data);
                blockTimes.push(f.time);
                offset += f.data.length;
            } else if (f.offset > offset) {
                // Gap in stream data — stop here
                break;
            } else {
                const overlap = offset - f.offset;
                if (overlap < f.data.length) {
                    blocks.push(f.data.subarray(overlap));
                    blockTimes.push(f.time);
                    offset += (f.data.length - overlap);
                }
            }
        }
        if (blocks.length === 0) return undefined;
        const total = blocks.reduce((acc, b) => acc + b.length, 0);
        const out = new Uint8Array(total);
        const segments = [];
        let p = 0;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            out.set(b, p);
            if (b.length > 0) {
                segments.push({ start: p, end: p + b.length, time: blockTimes[i] });
            }
            p += b.length;
        }
        const timeAt = (byteOffset) => {
            for (const seg of segments) {
                if (byteOffset >= seg.start && byteOffset < seg.end) return seg.time;
            }
            return segments.length > 0 ? segments[segments.length - 1].time : null;
        };
        const sliceChunks = (startByte, endByte) => {
            const chunks = [];
            for (const seg of segments) {
                if (seg.end <= startByte) continue;
                if (seg.start >= endByte) break;
                const s = Math.max(startByte, seg.start);
                const e = Math.min(endByte, seg.end);
                if (e > s) {
                    const slice = out.subarray(s, e);
                    chunks.push({ time: seg.time, length: slice.length, bytes: slice });
                }
            }
            return chunks;
        };
        return { buffer: out, startOffset, segments, timeAt, sliceChunks };
    };

    const concatUint8Arrays = (arrays) => {
        const total = arrays.reduce((acc, b) => acc + b.length, 0);
        const out = new Uint8Array(total);
        let p = 0;
        for (const b of arrays) {
            out.set(b, p); p += b.length;
        }
        return out;
    };

    const consolidated = new Map();
    for (const [id, fragments] of quicStreams.entries()) {
        if (fragments.length === 0) continue;
        
        const clientFrags = fragments.filter(f => f.isClient).sort((a,b) => a.offset - b.offset);
        const serverFrags = fragments.filter(f => !f.isClient).sort((a,b) => a.offset - b.offset);
        
        const sortedClient = fragments.filter(f => f.isClient).sort((a,b) => a.time - b.time);
        const sortedServer = fragments.filter(f => !f.isClient).sort((a,b) => a.time - b.time);
        const sortedAll = [...fragments].sort((a,b) => a.time - b.time);

        const clientAssembly = assemble(clientFrags);
        const serverAssembly = assemble(serverFrags);

        consolidated.set(id, {
            time: sortedAll[0].time,
            firstClientTime: sortedClient.length > 0 ? sortedClient[0].time : null,
            firstServerTime: sortedServer.length > 0 ? sortedServer[0].time : null,
            lastServerTime: sortedServer.length > 0 ? sortedServer[sortedServer.length - 1].time : null,
            clientBuffer: clientAssembly?.buffer ?? null,
            clientStartOffset: clientAssembly?.startOffset ?? 0,
            clientTimeAt: clientAssembly?.timeAt ?? null,
            clientSliceChunks: clientAssembly?.sliceChunks ?? null,
            serverBuffer: serverAssembly?.buffer ?? null,
            serverStartOffset: serverAssembly?.startOffset ?? 0,
            serverTimeAt: serverAssembly?.timeAt ?? null,
            serverSliceChunks: serverAssembly?.sliceChunks ?? null,
            id: id
        });
    }

    // Sort unidirectional streams by ID to match the creation order
    const uniStreams = [...consolidated.entries()]
        .filter(([id]) => (id & 0x02) !== 0)
        .sort(([a], [b]) => a - b);

    // Step 1: Pre-process unidirectional HTTP/3 control & QPACK encoder streams.
    // Identify the stream role by either reading the stream type byte (startOffset=0)
    // or by inferring from the QUIC stream ID (startOffset>0, mid-connection capture).
    const midstreamEncoderCandidates = { client: null, server: null };
    const hasExplicitEncoder = { client: false, server: false };

    for (const [id, stream] of uniStreams) {
        const isClientInit = (id & 0x01) === 0;
        const dirKey = isClientInit ? 'client' : 'server';
        const baseBuf = isClientInit ? stream.clientBuffer : stream.serverBuffer;
        const baseStartOffset = isClientInit ? stream.clientStartOffset : stream.serverStartOffset;
        const baseTimeAt = isClientInit ? stream.clientTimeAt : stream.serverTimeAt;
        if (!baseBuf) continue;

        let isControl = false;
        let isEncoder = false;
        let payloadBytes;
        let payloadOffset = 0;

        if (baseStartOffset === 0) {
            // Normal case: stream type is at the beginning
            const qb = new QuicBuffer(baseBuf);
            const streamType = qb.readVarInt();
            isControl = (streamType === 0x00);
            isEncoder = (streamType === 0x02);
            if (isEncoder) hasExplicitEncoder[dirKey] = true;
            payloadOffset = qb.offset;
            payloadBytes = baseBuf.subarray(qb.offset);
        } else {
            // Mid-connection capture: stream type byte was missed.
            // Infer role from QUIC unidirectional stream index:
            //   n=0: control, n=1/n=2: QPACK encoder & decoder (order varies by stack;
            //   the encoder stream carries header literals and is much larger than
            //   the 1-byte-per-request decoder ack stream).
            const uniIdx = isClientInit ? (id - 2) / 4 : (id - 3) / 4;
            payloadBytes = baseBuf;
            if (uniIdx === 1 || uniIdx === 2) {
                const prev = midstreamEncoderCandidates[dirKey];
                if (!prev || payloadBytes.length > prev.payloadBytes.length) {
                    midstreamEncoderCandidates[dirKey] = { id, isClientInit, payloadBytes, baseTimeAt };
                }
            }
        }

        if (isControl && payloadBytes.length > 0 && baseStartOffset === 0) {
            try {
                const cqb = new QuicBuffer(payloadBytes);
                while (cqb.remaining > 0) {
                    const fType = cqb.readVarInt();
                    const fLen = cqb.readVarInt();
                    if (fType === null || fLen === null) break;
                    const fPayload = cqb.readBytes(fLen);
                    if (!fPayload) break;
                    if (fType === 0x04) { // SETTINGS
                        const sqb = new QuicBuffer(fPayload);
                        while (sqb.remaining > 0) {
                            const settingId = sqb.readVarInt();
                            const settingVal = sqb.readVarInt();
                            if (settingId === null || settingVal === null) break;
                            if (settingId === 0x01) { // SETTINGS_QPACK_MAX_TABLE_CAPACITY
                                if (isClientInit) {
                                    qpackClientDec.setMaxTableCapacity(settingVal);
                                } else {
                                    qpackServerDec.setMaxTableCapacity(settingVal);
                                }
                            }
                        }
                    }
                }
            } catch { /* ignore truncated control frames */ }
        }

        if (isEncoder && payloadBytes.length > 0) {
            try {
                const timeAt = baseTimeAt ? (off) => baseTimeAt(payloadOffset + off) : null;
                if (isClientInit) {
                    qpackServerDec.processEncoder(payloadBytes, false, timeAt);
                } else {
                    qpackClientDec.processEncoder(payloadBytes, false, timeAt);
                }
            } catch(e) {
                if (globalThis.waterfallDebug) console.warn(`[HTTP3 Decoder] QPACK encoder processing failed for stream ${id}:`, e.message);
            }
        }
    }

    for (const dirKey of ['client', 'server']) {
        const cand = midstreamEncoderCandidates[dirKey];
        if (!hasExplicitEncoder[dirKey] && cand && cand.payloadBytes.length > 0) {
            try {
                if (cand.isClientInit) {
                    qpackServerDec.processEncoder(cand.payloadBytes, true, cand.baseTimeAt);
                } else {
                    qpackClientDec.processEncoder(cand.payloadBytes, true, cand.baseTimeAt);
                }
            } catch (e) {
                if (globalThis.waterfallDebug) console.warn(`[HTTP3 Decoder] Midstream QPACK encoder processing failed for stream ${cand.id}:`, e.message);
            }
        }
    }

    // Step 2: Build Bidirectional HTTP/3 Pairs (Requests and Responses) dynamically
    const mapHttp3 = new Map();
    for (const [id, stream] of consolidated.entries()) {
        const isBidirectional = (id & 0x02) === 0;

        if (isBidirectional) {
            const httpStream = {
                time: stream.time,
                firstClientTime: stream.firstClientTime,
                firstServerTime: stream.firstServerTime,
                lastServerTime: stream.lastServerTime,
                headers: [],
                informational: [],
                trailers: [],
                responses: []
            };

            const parseHttp3Frames = (baseBuf, isClientSide, timeAt, sliceChunks) => {
                const qb = new QuicBuffer(baseBuf);
                const currentRes = { headers: [], trailers: [], data: [], chunks: [], headersTime: null };
                
                while (qb.remaining > 0) {
                    const frameType = qb.readVarInt();
                    const frameLen = qb.readVarInt();
                    if (frameType === null || frameLen === null) {
                         break;
                    }

                    const payloadStart = qb.offset;
                    const payload = qb.readBytes(frameLen);
                    if (!payload) break;
                    const payloadEnd = qb.offset;
                    const frameTime = timeAt ? timeAt(Math.max(payloadStart, payloadEnd - 1)) : null;
                    
                    if (globalThis.waterfallDebug) console.log(`HTTP3 FRAME SEEN: type=0x${frameType.toString(16)} len=${frameLen} isClientSide=${isClientSide}`);

                    if (frameType === 0x01) { // HEADERS
                        try {
                            const parsedHeaders = isClientSide
                                ? qpackServerDec.decodeHeaders(payload, frameTime)
                                : qpackClientDec.decodeHeaders(payload, frameTime);
                            const cleaned = [];
                            for (const h of parsedHeaders) {
                                if (!h) continue;
                                // Replace unresolved dynamic table entries with a
                                // placeholder so the user knows the header existed but
                                // its name could not be recovered from the partial
                                // QPACK encoder stream (mid-connection capture).
                                if (h.name === 'unknown') {
                                    cleaned.push({ name: 'Unavailable', value: 'QPACK table entry unavailable' });
                                } else {
                                    cleaned.push(h);
                                }
                            }
                            if (isClientSide) {
                                if (httpStream.headers.length === 0) {
                                    httpStream.headers.push(...cleaned);
                                    if (frameTime !== null) httpStream.firstClientTime = frameTime;
                                } else {
                                    httpStream.trailers.push(...cleaned);
                                }
                            } else {
                                const statusHeader = cleaned.find(h => h.name === ':status');
                                const status = statusHeader ? parseInt(statusHeader.value, 10) : NaN;
                                if (status >= 100 && status < 200) {
                                    httpStream.informational.push({ time: frameTime ?? stream.firstServerTime ?? stream.time, headers: cleaned });
                                } else if (currentRes.headers.length === 0) {
                                    currentRes.headers.push(...cleaned);
                                    currentRes.headersTime = frameTime;
                                } else {
                                    currentRes.trailers.push(...cleaned);
                                    httpStream.trailers.push(...cleaned);
                                }
                            }
                        } catch (e) {
                             if (globalThis.waterfallDebug) console.warn("Qpack Header decoding block err", e);
                        }
                    } else if (frameType === 0x00) { // DATA
                        if (!isClientSide && payload.length > 0) {
                            currentRes.data.push(payload);
                            if (sliceChunks) {
                                currentRes.chunks.push(...sliceChunks(payloadStart, payloadEnd));
                            } else {
                                currentRes.chunks.push({
                                    time: frameTime ?? stream.firstServerTime ?? stream.time,
                                    length: payload.length,
                                    bytes: payload
                                });
                            }
                        }
                    }
                }
                if (!isClientSide && (currentRes.headers.length > 0 || currentRes.data.length > 0 || currentRes.trailers.length > 0)) {
                    // Consolidate data buffer for legacy consumers while preserving per-fragment chunks
                    if (currentRes.data.length > 0) {
                        currentRes.data = [concatUint8Arrays(currentRes.data)];
                    }
                    const firstNon1xxTime = currentRes.headersTime ?? (currentRes.chunks.length > 0 ? currentRes.chunks[0].time : stream.firstServerTime);
                    const lastNon1xxTime = currentRes.chunks.length > 0
                        ? currentRes.chunks[currentRes.chunks.length - 1].time
                        : (currentRes.headersTime ?? stream.lastServerTime);
                    if (firstNon1xxTime !== null && firstNon1xxTime !== undefined) {
                        httpStream.firstServerTime = firstNon1xxTime;
                    }
                    if (lastNon1xxTime !== null && lastNon1xxTime !== undefined) {
                        httpStream.lastServerTime = lastNon1xxTime;
                    }
                    currentRes.time = firstNon1xxTime ?? stream.time;
                    httpStream.responses.push(currentRes);
                }
            };
            
            if (stream.clientBuffer) parseHttp3Frames(stream.clientBuffer, true, stream.clientTimeAt, stream.clientSliceChunks);
            if (stream.serverBuffer) parseHttp3Frames(stream.serverBuffer, false, stream.serverTimeAt, stream.serverSliceChunks);
            
            if (httpStream.headers.length > 0 || httpStream.responses.length > 0 || httpStream.informational.length > 0) {
                mapHttp3.set(id, httpStream);
            }
        }
    }
    if (globalThis.waterfallDebug) console.log(`[HTTP3 Decoder] Produced ${mapHttp3.size} consolidated HTTP3 streams natively.`);
    return mapHttp3;
}
