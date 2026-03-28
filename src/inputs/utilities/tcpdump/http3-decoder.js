import { QuicBuffer } from './quic-buffer.js';
import { QpackDecoder } from './qpack-decoder.js';

export function decodeHttp3(quicStreams) {
    const qpackDec = new QpackDecoder();
    const requests = [];

    // First consolidate all Quic fragments tightly by Map ID offsets
    const consolidated = new Map();
    for (const [id, fragments] of quicStreams.entries()) {
        if (fragments.length === 0) continue;
        
        // Sort chronologically mapping continuous offsets
        fragments.sort((a,b) => a.offset - b.offset);

        let offset = 0;
        let blocks = [];
        let startTime = fragments[0].time;

        for (const f of fragments) {
            if (f.offset === offset) {
                blocks.push(f.data);
                offset += f.data.length;
            } else if (f.offset > offset) {
                // Ignore gaps internally bridging over offline traces
                break;
            } else {
                // Deduplicate overlap cleanly natively extending buffer lengths
                const overlap = offset - f.offset;
                if (overlap < f.data.length) {
                    blocks.push(f.data.subarray(overlap));
                    offset += (f.data.length - overlap);
                }
            }
        }
        
        if (blocks.length > 0) {
            consolidated.set(id, { time: startTime, buffer: Buffer.concat(blocks) });
        }
    }

    // Step 1: Pre-process unidirectional QPACK state streams fully mapped 
    for (const [id, stream] of consolidated.entries()) {
        const isClientInit = (id & 0x01) === 0;
        const isBidirectional = (id & 0x02) === 0;
        
        if (!isBidirectional) {
            const qb = new QuicBuffer(stream.buffer);
            const streamType = qb.readVarInt();
            
            if (streamType === 0x02) {
                // QPACK Encoder Stream (RFC 9204)
                const payloadBytes = stream.buffer.subarray(qb.offset);
                if (payloadBytes.length > 0) {
                    try {
                        qpackDec.processEncoder(payloadBytes);
                    } catch(e) {}
                }
            }
        }
    }

    // Step 2: Unpack Standard Bidirectional HTTP/3 Streams mappings (Client Requests)
    for (const [id, stream] of consolidated.entries()) {
        const isClientInit = (id & 0x01) === 0;
        const isBidirectional = (id & 0x02) === 0;

        if (isBidirectional && isClientInit) {
            const reqObj = {
                time: stream.time,
                firstLine: '',
                headers: [],
                data: []
            };

            const qb = new QuicBuffer(stream.buffer);
            
            while (qb.remaining > 0) {
                const frameType = qb.readVarInt();
                const frameLen = qb.readVarInt();
                
                if (frameType === null || frameLen === null) break;

                const payload = qb.readBytes(frameLen);
                if (!payload) break;

                if (frameType === 0x01) { // HEADERS
                    try {
                        const parsedHeaders = qpackDec.decodeHeaders(payload);
                        
                        let method = '';
                        let path = '';
                        let authority = '';
                        let scheme = '';
                        
                        // Parse pseudo-headers 
                        for (const h of parsedHeaders) {
                            if (!h) continue;
                            if (h.name === ':method') method = h.value;
                            else if (h.name === ':path') path = h.value;
                            else if (h.name === ':authority') authority = h.value;
                            else if (h.name === ':scheme') scheme = h.value;
                            else {
                                reqObj.headers.push(h);
                            }
                        }

                        if (method) {
                            const fullUrl = `${scheme ? scheme + '://' : 'https://'}${authority}${path}`;
                            reqObj.firstLine = `${method} ${fullUrl} HTTP/3`;
                        } else {
                            reqObj.firstLine = `HTTP/3 Response`;
                        }
                    } catch (e) {
                         console.warn("Qpack Header decoding block err", e);
                    }
                } else if (frameType === 0x00) { // DATA
                    reqObj.data.push({
                        time: stream.time, // Stream timestamp approximate boundaries
                        length: frameLen,
                        bytes: payload
                    });
                }
            }

            if (reqObj.firstLine) {
                requests.push(reqObj);
            }
        }
    }

    return requests;
}
