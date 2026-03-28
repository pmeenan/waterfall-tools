import hpack from 'hpack.js';

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
        
        let buf = Buffer.alloc(bytesToRead);
        let bytesCopied = 0;

        while (needed > 0 && cIdx < this.chunks.length) {
            const c = this.chunks[cIdx].bytes;
            const avail = c.length - cOffset;
            const take = Math.min(avail, needed);
            
            c.copy(buf, bytesCopied, cOffset, cOffset + take);
            bytesCopied += take;
            needed -= take;
            
            cIdx++;
            cOffset = 0;
        }

        if (needed > 0) return null; // Not enough bytes end-of-stream
        return buf;
    }

    // Consume bytes
    _consume(bytesToRead) {
        let needed = bytesToRead;
        while (needed > 0 && this.chunkIdx < this.chunks.length) {
            const currentChunk = this.chunks[this.chunkIdx].bytes;
            const avail = currentChunk.length - this.offset;
            
            if (avail > needed) {
                this.offset += needed;
                needed = 0;
            } else {
                needed -= avail;
                this.chunkIdx++;
                this.offset = 0;
            }
        }
    }

    _peekTime() {
        if (this.chunkIdx < this.chunks.length) {
            return this.chunks[this.chunkIdx].time;
        }
        return 0;
    }

    readFrame(isClient = false) {
        let time = this._peekTime();
        
        const headerBuf = this._peek(9);
        if (!headerBuf) return null; // End of stream

        const lengthPayload = (headerBuf[0] << 16) | (headerBuf[1] << 8) | headerBuf[2];
        const type = headerBuf[3];
        const flags = headerBuf[4];
        const streamId = headerBuf.readUInt32BE(5) & 0x7FFFFFFF;

        const fullLength = 9 + lengthPayload;
        
        // Wait, what if the entire frame isn't buffered yet?
        // Let's see if we have enough bytes. If not, it's a truncated connection.
        const frameBuf = this._peek(fullLength);
        if (!frameBuf) {
            // Truncated frame, consume remainder to stop inf loop
            this._consume(9);
            return null;
        }

        this._consume(fullLength);
        
        const payload = frameBuf.subarray(9);

        return {
            time,
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
    
    // Decompressor context
    const clientDecompressor = hpack.decompressor.create();
    const serverDecompressor = hpack.decompressor.create();

    const result = {
        streams: new Map(),
        connection: {
            settings: [],
            pings: [],
            goaways: []
        }
    };

    function getStream(id) {
        if (!result.streams.has(id)) {
            result.streams.set(id, {
                id,
                headers: { client: [], server: [], clientTime: 0, serverTime: 0 },
                data: { client: [], server: [] },
                priority: null,
                closed: false
            });
        }
        return result.streams.get(id);
    }

    function processFrames(reader, decompressor, direction) {
        let frame;
        while ((frame = reader.readFrame(direction === 'client')) !== null) {
            const { type, flags, streamId, payload, time } = frame;
            
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

            const stream = getStream(streamId);

            if (type === 0) { // DATA
                stream.data[direction].push({
                    time,
                    length: payload.length,
                    bytes: payload
                });
                if (flags & 0x01) stream.closed = true;
            } else if (type === 1 || type === 9) { // HEADERS or CONTINUATION
                let headerBlockFragment = payload;
                if (type === 1) { 
                    let offset = 0;
                    if (flags & 0x08) { // PADDED
                        const padLength = payload[0];
                        offset += 1;
                        headerBlockFragment = payload.subarray(offset, payload.length - padLength);
                    }
                    if (flags & 0x20) { // PRIORITY
                        offset += 5; 
                        headerBlockFragment = headerBlockFragment.subarray(5); 
                    }
                }
                
                try {
                    const headers = decompressor.execute(headerBlockFragment);
                    if (stream.headers[direction + 'Time'] === 0) {
                        stream.headers[direction + 'Time'] = time;
                    }
                    // hpack.js execute returns an object where keys are header names and values are strings
                    // or arrays of strings
                    for (const [name, value] of Object.entries(headers)) {
                        if (Array.isArray(value)) {
                            value.forEach(v => stream.headers[direction].push({ name, value: v }));
                        } else {
                            stream.headers[direction].push({ name, value });
                        }
                    }
                } catch (e) {
                    console.error(`[HTTP/2] HPACK Decompression Error on Stream ${streamId}:`, e.message);
                }

                if (flags & 0x01) { // END_STREAM
                    stream.closed = true;
                }
            } else if (type === 2) { // PRIORITY
                stream.priority = payload;
            } else if (type === 3) { // RST_STREAM
                stream.rst = payload;
                stream.closed = true;
            }
        }
    }

    processFrames(clientReader, clientDecompressor, 'client');
    processFrames(serverReader, serverDecompressor, 'server');

    return result;
}
