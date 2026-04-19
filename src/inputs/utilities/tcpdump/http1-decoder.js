/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
class Http1Parser {
    constructor(chunks) {
        this.chunks = chunks; // Array of { time, bytes }
        this.chunkIdx = 0;
        this.offset = 0;
        
        // Accumulator
        this.state = 'HEADERS'; // 'HEADERS', 'BODY_LENGTH', 'BODY_CHUNKED', 'BODY_EOF', 'FINISHED'
        this.headersBuf = [];
        this.headersLen = 0;

        this.bodyRemaining = 0;
        this.chunkSize = -1; // For chunked encoding
        
        // Output requests
        this.messages = []; 
        this.currentMessage = null;
    }

    _peekByte() {
        if (this.chunkIdx >= this.chunks.length) return null;
        return this.chunks[this.chunkIdx].bytes[this.offset];
    }
    
    _consume(n) {
        let needed = n;
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

    // Attempt to read until \r\n\r\n.
    // Builds a single contiguous buffer incrementally and searches only from
    // the overlap region where the CRLF2 delimiter could span two chunks,
    // avoiding the prior O(n²) pattern of re-concatenating and re-scanning
    // the entire accumulator on every iteration. Also caps at 256KB to bail
    // out quickly on non-HTTP data (e.g. encrypted streams falsely sniffed
    // as HTTP/1.1).
    _readHeaders() {
        let cIdx = this.chunkIdx;
        let cOffset = this.offset;

        let buffer = null;       // Single growing buffer
        let searchFrom = 0;      // Byte offset to start searching from
        const MAX_HEADER_SCAN = 262144; // 256KB — no valid HTTP header is this large

        while (cIdx < this.chunks.length) {
            const buf = this.chunks[cIdx].bytes;
            const slice = buf.subarray(cOffset);

            // Grow the buffer by appending the new slice
            if (!buffer) {
                buffer = new Uint8Array(slice);
            } else {
                const newBuf = new Uint8Array(buffer.length + slice.length);
                newBuf.set(buffer);
                newBuf.set(slice, buffer.length);
                buffer = newBuf;
            }

            // Search only from where the 4-byte sequence could span the boundary
            // between the previously scanned region and the newly appended bytes.
            const start = Math.max(0, searchFrom - 3);
            for (let i = start; i <= buffer.length - 4; i++) {
                if (buffer[i] === 13 && buffer[i + 1] === 10 &&
                    buffer[i + 2] === 13 && buffer[i + 3] === 10) {
                    const headersRaw = buffer.subarray(0, i + 4);
                    const time = this.chunks[this.chunkIdx].time;
                    this._consume(i + 4);
                    return { time, bytes: headersRaw };
                }
            }
            searchFrom = buffer.length;

            // Bail out if we've scanned past any reasonable header size —
            // this data is almost certainly not HTTP.
            if (buffer.length > MAX_HEADER_SCAN) return null;

            cIdx++;
            cOffset = 0;
        }
        return null;
    }

    // Read exactly n bytes for Content-Length body. Group by chunks
    _readLengthBody(_len) {
        const extractedChunks = [];
        while (this.bodyRemaining > 0 && this.chunkIdx < this.chunks.length) {
            const c = this.chunks[this.chunkIdx].bytes;
            const avail = c.length - this.offset;

            // Skip empty chunks to prevent infinite loop (see parse() comment)
            if (avail <= 0) {
                this.chunkIdx++;
                this.offset = 0;
                continue;
            }

            const time = this.chunks[this.chunkIdx].time;
            const take = Math.min(avail, this.bodyRemaining);
            extractedChunks.push({
                time,
                length: take,
                bytes: c.subarray(this.offset, this.offset + take)
            });

            this.bodyRemaining -= take;
            this._consume(take);
        }
        return extractedChunks;
    }

    // Parses the textual headers to identify body mechanism
    _parseHeaders(headerBuf) {
        const text = new TextDecoder('ascii').decode(headerBuf);
        const lines = text.split('\r\n');
        const firstLine = lines.shift() || "";
        
        const headers = [];
        let isChunked = false;
        let contentLength = -1;

        for (const line of lines) {
            if (!line) continue;
            const sep = line.indexOf(':');
            if (sep !== -1) {
                const name = line.substring(0, sep).trim();
                const value = line.substring(sep + 1).trim();
                headers.push({ name, value });

                const lowerName = name.toLowerCase();
                if (lowerName === 'transfer-encoding' && value.toLowerCase().includes('chunked')) {
                    isChunked = true;
                } else if (lowerName === 'content-length') {
                    contentLength = parseInt(value, 10);
                }
            }
        }
        return { firstLine, headers, isChunked, contentLength };
    }

    parse() {
        while (this.chunkIdx < this.chunks.length) {
            // Skip zero-length chunks that would stall progress. TLS decryption
            // can produce empty records (alerts, ChangeCipherSpec, close_notify)
            // and TCP reconstruction may emit empty segments from ACK-only packets.
            // Without this guard, _consume(0) is a no-op and body processing
            // states loop forever on the same chunkIdx.
            if (this.chunks[this.chunkIdx].bytes.length - this.offset <= 0) {
                this.chunkIdx++;
                this.offset = 0;
                continue;
            }

            if (this.state === 'HEADERS') {
                const headersObj = this._readHeaders();
                if (!headersObj) break; // Incomplete headers
                
                const meta = this._parseHeaders(headersObj.bytes);
                this.currentMessage = {
                    time: headersObj.time,
                    firstLine: meta.firstLine,
                    headers: meta.headers,
                    data: []
                };

                if (meta.isChunked) {
                    this.state = 'BODY_CHUNKED';
                } else if (meta.contentLength >= 0) {
                    this.state = 'BODY_LENGTH';
                    this.bodyRemaining = meta.contentLength;
                    if (this.bodyRemaining === 0) {
                        this.messages.push(this.currentMessage);
                        this.state = 'HEADERS';
                    }
                } else {
                    // Assume EOF termination (typically for responses without length)
                    this.state = 'BODY_EOF';
                }
            } else if (this.state === 'BODY_LENGTH') {
                const chunks = this._readLengthBody(this.bodyRemaining);
                this.currentMessage.data.push(...chunks);
                if (this.bodyRemaining === 0) {
                    this.messages.push(this.currentMessage);
                    this.state = 'HEADERS';
                }
            } else if (this.state === 'BODY_EOF') {
                // Read everything remaining
                const avail = this.chunks[this.chunkIdx].bytes.length - this.offset;
                this.currentMessage.data.push({
                    time: this.chunks[this.chunkIdx].time,
                    length: avail,
                    bytes: this.chunks[this.chunkIdx].bytes.subarray(this.offset)
                });
                this._consume(avail);
            } else if (this.state === 'BODY_CHUNKED') {
                // Chunked encoding requires parsing hex lengths and \r\n.
                // For a robust implementation without massive complexity, we will lazily 
                // consume anything left until Connection Close as Body for now unless strictly tracked.
                // Complete correct implementation requires hex sniffing.
                const avail = this.chunks[this.chunkIdx].bytes.length - this.offset;
                this.currentMessage.data.push({
                    time: this.chunks[this.chunkIdx].time,
                    length: avail,
                    bytes: this.chunks[this.chunkIdx].bytes.subarray(this.offset)
                });
                this._consume(avail);
            }
        }
        
        // Push trailing message if stream ended
        if (this.currentMessage && this.state === 'BODY_EOF') {
            this.messages.push(this.currentMessage);
        }
        
        return this.messages;
    }
}

export function decodeHttp1(clientChunks, serverChunks) {
    const clientParser = new Http1Parser(clientChunks);
    const serverParser = new Http1Parser(serverChunks);

    const clientMessages = clientParser.parse();
    const serverMessages = serverParser.parse();

    return {
        requests: clientMessages,
        responses: serverMessages
    };
}
