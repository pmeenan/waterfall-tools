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
    const requests = [];

    // Assembles contiguous stream fragments into a single buffer.
    // Returns { buffer, startOffset } where startOffset is the byte offset of the
    // first available fragment. For streams captured from the beginning, startOffset = 0.
    // For mid-connection captures, startOffset may be non-zero (data before it was missed).
    const assemble = (frags) => {
        if (!frags || frags.length === 0) return undefined;
        // Start from the first available fragment's offset instead of requiring offset 0.
        // This allows partial assembly of streams that began before the capture started.
        let offset = frags[0].offset;
        const startOffset = offset;
        let blocks = [];
        for (const f of frags) {
            if (f.offset === offset) {
                blocks.push(f.data);
                offset += f.data.length;
            } else if (f.offset > offset) {
                // Gap in stream data — stop here
                break;
            } else {
                const overlap = offset - f.offset;
                if (overlap < f.data.length) {
                    blocks.push(f.data.subarray(overlap));
                    offset += (f.data.length - overlap);
                }
            }
        }
        if (blocks.length === 0) return undefined;
        let total = blocks.reduce((acc, b) => acc + b.length, 0);
        let out = new Uint8Array(total);
        let p = 0;
        for (let b of blocks) {
            out.set(b, p); p += b.length;
        }
        return { buffer: out, startOffset };
    };

    const concatUint8Arrays = (arrays) => {
        let total = arrays.reduce((acc, b) => acc + b.length, 0);
        let out = new Uint8Array(total);
        let p = 0;
        for (let b of arrays) {
            out.set(b, p); p += b.length;
        }
        return out;
    };

    const consolidated = new Map();
    for (const [id, fragments] of quicStreams.entries()) {
        if (fragments.length === 0) continue;
        
        let clientFrags = fragments.filter(f => f.isClient).sort((a,b) => a.offset - b.offset);
        let serverFrags = fragments.filter(f => !f.isClient).sort((a,b) => a.offset - b.offset);
        
        let sortedClient = fragments.filter(f => f.isClient).sort((a,b) => a.time - b.time);
        let sortedServer = fragments.filter(f => !f.isClient).sort((a,b) => a.time - b.time);
        let sortedAll = [...fragments].sort((a,b) => a.time - b.time);

        const clientAssembly = assemble(clientFrags);
        const serverAssembly = assemble(serverFrags);

        consolidated.set(id, {
            time: sortedAll[0].time,
            firstClientTime: sortedClient.length > 0 ? sortedClient[0].time : null,
            firstServerTime: sortedServer.length > 0 ? sortedServer[0].time : null,
            lastServerTime: sortedServer.length > 0 ? sortedServer[sortedServer.length - 1].time : null,
            clientBuffer: clientAssembly?.buffer ?? null,
            clientStartOffset: clientAssembly?.startOffset ?? 0,
            serverBuffer: serverAssembly?.buffer ?? null,
            serverStartOffset: serverAssembly?.startOffset ?? 0,
            id: id
        });
    }

    // Sort unidirectional streams by ID to match the creation order
    const uniStreams = [...consolidated.entries()]
        .filter(([id]) => (id & 0x02) !== 0)
        .sort(([a], [b]) => a - b);

    // Step 1: Pre-process unidirectional QPACK encoder streams.
    // Identify the encoder stream by either reading the stream type byte (startOffset=0)
    // or by inferring from the QUIC stream ID (startOffset>0, mid-connection capture).
    for (const [id, stream] of uniStreams) {
        const isClientInit = (id & 0x01) === 0;
        const baseBuf = isClientInit ? stream.clientBuffer : stream.serverBuffer;
        const baseStartOffset = isClientInit ? stream.clientStartOffset : stream.serverStartOffset;
        if (!baseBuf) continue;

        let isEncoder = false;
        let payloadBytes;

        if (baseStartOffset === 0) {
            // Normal case: stream type is at the beginning
            const qb = new QuicBuffer(baseBuf);
            const streamType = qb.readVarInt();
            isEncoder = (streamType === 0x02);
            payloadBytes = baseBuf.subarray(qb.offset);
        } else {
            // Mid-connection capture: stream type byte was missed.
            // Infer type from the QUIC stream ID. HTTP/3 convention:
            //   Client-initiated uni: ID = 4*n + 2 → n=0: control, n=1: encoder, n=2: decoder
            //   Server-initiated uni: ID = 4*n + 3 → same pattern
            const uniIdx = isClientInit ? (id - 2) / 4 : (id - 3) / 4;
            isEncoder = (uniIdx === 1);
            // The entire buffer is payload (stream type byte was in the missing data)
            payloadBytes = baseBuf;
        }

        if (isEncoder && payloadBytes.length > 0) {
            try {
                if (isClientInit) {
                    qpackServerDec.processEncoder(payloadBytes, baseStartOffset > 0);
                } else {
                    qpackClientDec.processEncoder(payloadBytes, baseStartOffset > 0);
                }
            } catch(e) {
                if (globalThis.waterfallDebug) console.warn(`[HTTP3 Decoder] QPACK encoder processing failed for stream ${id}:`, e.message);
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
                responses: []
            };

            const parseHttp3Frames = (baseBuf, isClientSide) => {
                const qb = new QuicBuffer(baseBuf);
                let currentRes = { headers: [], data: [] };
                
                while (qb.remaining > 0) {
                    const frameType = qb.readVarInt();
                    const frameLen = qb.readVarInt();
                    if (frameType === null || frameLen === null) {
                         break;
                    }

                    const payload = qb.readBytes(frameLen);
                    if (!payload) break;
                    
                    if (globalThis.waterfallDebug) console.log(`HTTP3 FRAME SEEN: type=0x${frameType.toString(16)} len=${frameLen} isClientSide=${isClientSide}`);

                    if (frameType === 0x01) { // HEADERS
                        try {
                            const parsedHeaders = isClientSide ? qpackServerDec.decodeHeaders(payload) : qpackClientDec.decodeHeaders(payload);
                            for (const h of parsedHeaders) {
                                if (!h) continue;
                                // Replace unresolved dynamic table entries with a
                                // placeholder so the user knows the header existed but
                                // its name could not be recovered from the partial
                                // QPACK encoder stream (mid-connection capture).
                                if (h.name === 'unknown') {
                                    h.name = 'Unavailable';
                                    h.value = 'QPACK table entry unavailable';
                                }
                                if (isClientSide) {
                                    httpStream.headers.push(h);
                                } else {
                                    currentRes.headers.push(h);
                                }
                            }
                        } catch (e) {
                             if (globalThis.waterfallDebug) console.warn("Qpack Header decoding block err", e);
                        }
                    } else if (frameType === 0x00) { // DATA
                        if (!isClientSide) {
                            currentRes.data.push(payload);
                        }
                    }
                }
                if (!isClientSide && (currentRes.headers.length > 0 || currentRes.data.length > 0)) {
                    // Consolidate data buffer
                    if (currentRes.data.length > 0) {
                        currentRes.data = [concatUint8Arrays(currentRes.data)];
                    }
                    currentRes.time = stream.time;
                    httpStream.responses.push(currentRes);
                }
            };
            
            if (stream.clientBuffer) parseHttp3Frames(stream.clientBuffer, true);
            if (stream.serverBuffer) parseHttp3Frames(stream.serverBuffer, false);
            
            if (httpStream.headers.length > 0 || httpStream.responses.length > 0) {
                mapHttp3.set(id, httpStream);
            }
        }
    }
    if (globalThis.waterfallDebug) console.log(`[HTTP3 Decoder] Produced ${mapHttp3.size} consolidated HTTP3 streams natively.`);
    return mapHttp3;
}
