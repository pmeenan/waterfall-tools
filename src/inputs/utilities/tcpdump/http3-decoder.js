import { QuicBuffer } from './quic-buffer.js';
import { QpackDecoder } from './qpack-decoder.js';

export function decodeHttp3(quicStreams) {
    // QPACK Requires two distinct dynamic tables (RFC 9204)
    const qpackClientDec = new QpackDecoder();
    const qpackServerDec = new QpackDecoder();
    const requests = [];

    const assemble = (frags) => {
        if (!frags || frags.length === 0) return undefined;
        let offset = 0;
        let blocks = [];
        for (const f of frags) {
            if (f.offset === offset) {
                blocks.push(f.data);
                offset += f.data.length;
            } else if (f.offset > offset) {
                // Ignore gaps internally
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
        return out;
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

        consolidated.set(id, {
            time: sortedAll[0].time,
            firstClientTime: sortedClient.length > 0 ? sortedClient[0].time : null,
            firstServerTime: sortedServer.length > 0 ? sortedServer[0].time : null,
            lastServerTime: sortedServer.length > 0 ? sortedServer[sortedServer.length - 1].time : null,
            clientBuffer: assemble(clientFrags),
            serverBuffer: assemble(serverFrags),
            id: id
        });
    }

    // Step 1: Pre-process unidirectional QPACK state streams fully mapped 
    for (const [id, stream] of consolidated.entries()) {
        const isClientInit = (id & 0x01) === 0;
        const isBidirectional = (id & 0x02) === 0;
        
        if (!isBidirectional) {
            // Unidirectional streams are sent entirely by initiator.
            // Client-initiated uni: sent by client, so it's in clientBuffer.
            // Server-initiated uni: sent by server, so it's in serverBuffer.
            const baseBuf = isClientInit ? stream.clientBuffer : stream.serverBuffer;
            if (!baseBuf) continue;

            const qb = new QuicBuffer(baseBuf);
            const streamType = qb.readVarInt();
            
            if (streamType === 0x02) {
                // QPACK Encoder Stream (RFC 9204)
                const payloadBytes = baseBuf.subarray(qb.offset);
                if (payloadBytes.length > 0) {
                    try {
                        if (isClientInit) {
                            qpackServerDec.processEncoder(payloadBytes);
                        } else {
                            qpackClientDec.processEncoder(payloadBytes);
                        }
                    } catch(e) {}
                }
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
                    
                    console.log(`HTTP3 FRAME SEEN: type=0x${frameType.toString(16)} len=${frameLen} isClientSide=${isClientSide}`);

                    if (frameType === 0x01) { // HEADERS
                        try {
                            const parsedHeaders = isClientSide ? qpackServerDec.decodeHeaders(payload) : qpackClientDec.decodeHeaders(payload);
                            if (parsedHeaders) console.log(`HEADERS DECODED: parsed=${parsedHeaders.length}, buffer=${payload.length}`);
                            for (const h of parsedHeaders) {
                                if (!h) continue;
                                if (isClientSide) {
                                    httpStream.headers.push(h);
                                } else {
                                    currentRes.headers.push(h);
                                }
                            }
                        } catch (e) {
                             console.warn("Qpack Header decoding block err", e);
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
    console.log(`[HTTP3 Decoder] Produced ${mapHttp3.size} consolidated HTTP3 streams natively.`);
    return mapHttp3;
}
