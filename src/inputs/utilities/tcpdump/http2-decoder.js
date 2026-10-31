/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { HpackDecoder } from './hpack-decoder.js';

class Http2FrameReader {
    constructor(chunks) {
        this.chunks = chunks; // Array of { time, bytes }
        this.chunkIdx = 0;
        this.offset = 0;
    }

    // Peeks exactly `bytesToRead` bytes. Doesn't consume them. Returns Buffer or null.
    _peek(bytesToRead) {
        if (this.chunkIdx >= this.chunks.length) return null;

        const currentChunk = this.chunks[this.chunkIdx].bytes;
        const availableInChunk = currentChunk.length - this.offset;

        if (availableInChunk >= bytesToRead) {
            return currentChunk.subarray(this.offset, this.offset + bytesToRead);
        }

        // Need to read across chunks
        let needed = bytesToRead;
        let cIdx = this.chunkIdx;
        let cOffset = this.offset;
        
        const buf = new Uint8Array(bytesToRead);
        let bytesCopied = 0;

        while (needed > 0 && cIdx < this.chunks.length) {
            const c = this.chunks[cIdx].bytes;
            const avail = c.length - cOffset;
            const take = Math.min(avail, needed);
            
            buf.set(c.subarray(cOffset, cOffset + take), bytesCopied);
            bytesCopied += take;
            needed -= take;
            
            cIdx++;
            cOffset = 0;
        }

        if (needed > 0) return null; // Not enough bytes end-of-stream
        return buf;
    }

    // Consume bytes. Returns the timestamp of the chunk that held the last
    // consumed byte (i.e. when the consumed data had fully arrived).
    _consume(bytesToRead) {
        let needed = bytesToRead;
        let lastTime = this._peekTime();
        while (needed > 0 && this.chunkIdx < this.chunks.length) {
            const currentChunk = this.chunks[this.chunkIdx].bytes;
            const avail = currentChunk.length - this.offset;
            if (avail > 0) lastTime = this.chunks[this.chunkIdx].time;

            if (avail > needed) {
                this.offset += needed;
                needed = 0;
            } else {
                needed -= avail;
                this.chunkIdx++;
                this.offset = 0;
            }
        }
        return lastTime;
    }

    _peekTime() {
        if (this.chunkIdx < this.chunks.length) {
            return this.chunks[this.chunkIdx].time;
        }
        return 0;
    }

    readFrame(_isClient = false) {
        // Skip exhausted / empty chunks so the frame start time is accurate
        while (this.chunkIdx < this.chunks.length && this.chunks[this.chunkIdx].bytes.length - this.offset <= 0) {
            this.chunkIdx++;
            this.offset = 0;
        }
        const startTime = this._peekTime();

        const headerBuf = this._peek(9);
        if (!headerBuf) return null; // End of stream

        const lengthPayload = (headerBuf[0] << 16) | (headerBuf[1] << 8) | headerBuf[2];
        const type = headerBuf[3];
        const flags = headerBuf[4];
        const view = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
        const streamId = view.getUint32(5, false) & 0x7FFFFFFF;

        const fullLength = 9 + lengthPayload;
        
        // Wait, what if the entire frame isn't buffered yet?
        // Let's see if we have enough bytes. If not, it's a truncated connection.
        const frameBuf = this._peek(fullLength);
        if (!frameBuf) {
            // Truncated frame, consume remainder to stop inf loop
            this._consume(9);
            return null;
        }

        // Stamp the frame with the time its last byte arrived: a frame
        // isn't usable (e.g. DATA bytes delivered) until it is complete.
        const time = this._consume(fullLength);
        
        const payload = frameBuf.subarray(9);

        return {
            time,
            startTime,
            length: lengthPayload,
            type,
            flags,
            streamId,
            payload
        };
    }
}

export function decodeHttp2(clientChunks, serverChunks) {
    // 1. Client magic bytes are 24 bytes. Skip them.
    const clientReader = new Http2FrameReader(clientChunks);
    if (clientReader._peek(24)) {
        clientReader._consume(24);
    }
    
    const serverReader = new Http2FrameReader(serverChunks);
    
    // HPACK decoder context (browser-native, no Node Buffer dependency)
    const clientDecompressor = new HpackDecoder({ maxSize: 4096 });
    const serverDecompressor = new HpackDecoder({ maxSize: 4096 });

    const result = {
        streams: new Map(),
        connection: {
            settings: [],
            pings: [],
            goaways: []
        }
    };

    /**
     * Parses a 5-byte HTTP/2 priority payload into structured fields.
     * Format: 1 bit exclusive, 31 bits stream dependency, 8 bits weight (0-255).
     * Actual weight = value + 1 (1-256). Maps to Chrome priority strings using
     * the same thresholds as netlog.js.
     */
    function parsePriority(buf) {
        if (!buf || buf.length < 5) return null;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const depAndExclusive = view.getUint32(0, false);
        const exclusive = (depAndExclusive & 0x80000000) !== 0;
        const dependency = depAndExclusive & 0x7FFFFFFF;
        const weight = buf[4] + 1; // HTTP/2 weight is 1-256, wire value is 0-255
        let priority;
        if (weight >= 256) priority = 'Highest';
        else if (weight >= 220) priority = 'High';
        else if (weight >= 183) priority = 'Medium';
        else if (weight >= 147) priority = 'Low';
        else priority = 'Lowest';
        return { exclusive, dependency, weight, priority };
    }

    function getStream(id) {
        if (!result.streams.has(id)) {
            result.streams.set(id, {
                id,
                headers: { client: [], server: [], clientTime: 0, serverTime: 0 },
                data: { client: [], server: [] },
                // 1xx interim responses (e.g. 103 Early Hints): [{ time, headers }]
                informational: [],
                // Trailer header blocks received after the final headers
                trailers: { client: [], server: [] },
                priority: null,
                closed: false
            });
        }
        return result.streams.get(id);
    }

    /**
     * Strips the Pad Length byte and trailing padding from a frame payload
     * when the PADDED flag (0x08) is set. Returns null for malformed padding.
     */
    function stripPadding(payload, flags) {
        if (!(flags & 0x08)) return payload;
        if (payload.length < 1) return null;
        const padLength = payload[0];
        if (padLength >= payload.length) return null;
        return payload.subarray(1, payload.length - padLength);
    }

    function applyHeaderBlock(stream, direction, decodedHeaders, time) {
        const statusHeader = direction === 'server' ? decodedHeaders.find(h => h.name === ':status') : null;
        const status = statusHeader ? parseInt(statusHeader.value, 10) : NaN;
        if (direction === 'server' && status >= 100 && status < 200) {
            // Interim response — keep out of the final status/TTFB
            stream.informational.push({ time, headers: decodedHeaders.map(h => ({ name: h.name, value: h.value })) });
            return;
        }
        if (stream.headers[direction].length > 0) {
            // A second (non-1xx) header block after the final headers is a trailer block
            for (const header of decodedHeaders) {
                stream.trailers[direction].push({ name: header.name, value: header.value });
            }
            return;
        }
        if (stream.headers[direction + 'Time'] === 0) {
            stream.headers[direction + 'Time'] = time;
        }
        for (const header of decodedHeaders) {
            stream.headers[direction].push({ name: header.name, value: header.value });
        }
    }

    function processFrames(reader, decompressor, direction) {
        let frame;
        // HEADERS / PUSH_PROMISE block awaiting CONTINUATION frames
        let pending = null;

        const finishHeaderBlock = (block) => {
            const total = block.fragments.reduce((acc, f) => acc + f.length, 0);
            const buf = new Uint8Array(total);
            let o = 0;
            for (const f of block.fragments) { buf.set(f, o); o += f.length; }
            let decodedHeaders;
            try {
                decodedHeaders = decompressor.decode(buf);
            } catch (e) {
                if (globalThis.waterfallDebug) console.error(`[HTTP/2] HPACK Decompression Error on Stream ${block.streamId}:`, e.message);
                return;
            }
            if (block.promisedStreamId !== undefined) {
                // PUSH_PROMISE: the header block is the pushed request's headers
                const pushed = getStream(block.promisedStreamId);
                pushed.pushed = true;
                if (pushed.headers.client.length === 0) {
                    pushed.headers.clientTime = block.time;
                    for (const header of decodedHeaders) {
                        pushed.headers.client.push({ name: header.name, value: header.value });
                    }
                }
                return;
            }
            const stream = getStream(block.streamId);
            applyHeaderBlock(stream, direction, decodedHeaders, block.time);
            if (block.endStream) stream.closed = true;
        };

        while ((frame = reader.readFrame(direction === 'client')) !== null) {
            const { type, flags, streamId, payload, time } = frame;

            // A header block must be followed immediately by its CONTINUATION
            // frames. Anything else means the block was truncated/corrupt;
            // decode what we have so the HPACK table stays as close as possible.
            if (pending && !(type === 9 && streamId === pending.streamId)) {
                finishHeaderBlock(pending);
                pending = null;
            }

            if (streamId === 0) {
                if (type === 4) { // SETTINGS
                    result.connection.settings.push({ direction, time, bytes: payload });
                    // HTTP/2 defines SETTINGS_HEADER_TABLE_SIZE (0x1)
                    // If a specific setting changes table size, we would update decompressor.updateTableSize()
                } else if (type === 6) { // PING
                    result.connection.pings.push({ direction, time, flag: flags });
                } else if (type === 7) { // GOAWAY
                    result.connection.goaways.push({ direction, time, payload });
                }
                continue;
            }

            if (type === 0) { // DATA
                const stream = getStream(streamId);
                const data = stripPadding(payload, flags);
                if (data && data.length > 0) {
                    stream.data[direction].push({
                        time,
                        length: data.length,
                        bytes: data
                    });
                }
                if (flags & 0x01) stream.closed = true;
            } else if (type === 1) { // HEADERS
                const stream = getStream(streamId);
                let headerBlockFragment = stripPadding(payload, flags);
                if (!headerBlockFragment) continue;
                if (flags & 0x20) { // PRIORITY
                    // Extract the 5-byte priority data before skipping it
                    const priorityData = parsePriority(headerBlockFragment.subarray(0, 5));
                    if (priorityData && !stream.priority) {
                        stream.priority = priorityData;
                    }
                    headerBlockFragment = headerBlockFragment.subarray(5);
                }
                const block = { streamId, fragments: [headerBlockFragment], time, endStream: (flags & 0x01) !== 0 };
                if (flags & 0x04) { // END_HEADERS
                    finishHeaderBlock(block);
                } else {
                    pending = block;
                }
            } else if (type === 9) { // CONTINUATION
                if (pending && pending.streamId === streamId) {
                    pending.fragments.push(payload);
                    if (flags & 0x04) { // END_HEADERS
                        finishHeaderBlock(pending);
                        pending = null;
                    }
                }
            } else if (type === 5) { // PUSH_PROMISE
                const body = stripPadding(payload, flags);
                if (!body || body.length < 4) continue;
                const promisedStreamId = ((body[0] & 0x7F) * 0x1000000) + (body[1] << 16) + (body[2] << 8) + body[3];
                const block = { streamId, promisedStreamId, fragments: [body.subarray(4)], time };
                if (flags & 0x04) { // END_HEADERS
                    finishHeaderBlock(block);
                } else {
                    pending = block;
                }
            } else if (type === 2) { // PRIORITY
                const stream = getStream(streamId);
                stream.priority = parsePriority(payload) || payload;
            } else if (type === 3) { // RST_STREAM
                const stream = getStream(streamId);
                stream.rst = payload;
                stream.closed = true;
            }
        }
        if (pending) finishHeaderBlock(pending);
    }

    processFrames(clientReader, clientDecompressor, 'client');
    processFrames(serverReader, serverDecompressor, 'server');

    return result;
}
