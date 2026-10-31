/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

const MAX_HEADER_SCAN = 262144; // 256KB — no valid HTTP header is this large
const MAX_LINE_SCAN = 8192;     // Chunk-size / trailer lines are tiny

class Http1Parser {
    /**
     * @param {Array<{time:number, bytes:Uint8Array}>} chunks
     * @param {string[]} [requestMethods] - Methods of the requests this side's
     *   responses answer, in order. Needed because responses to HEAD carry
     *   no body regardless of their Content-Length.
     */
    constructor(chunks, requestMethods = []) {
        this.chunks = chunks; // Array of { time, bytes }
        this.chunkIdx = 0;
        this.offset = 0;
        this.requestMethods = requestMethods;
        this.responseIndex = 0; // Index of the next final response (pairs with requestMethods)

        // Accumulator
        // 'HEADERS', 'BODY_LENGTH', 'CHUNK_SIZE', 'CHUNK_DATA', 'CHUNK_CRLF',
        // 'CHUNK_TRAILERS', 'BODY_EOF', 'FINISHED'
        this.state = 'HEADERS';

        this.bodyRemaining = 0;

        // Output messages
        this.messages = []; 
        this.currentMessage = null;
        // 1xx informational responses waiting to be attached to the next final response
        this.pendingInformational = [];
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

    // Scans forward (without consuming) for `delimiter` across chunk
    // boundaries. Builds a single contiguous buffer incrementally and searches
    // only from the overlap region where the delimiter could span two chunks.
    // Caps the scan at `maxScan` bytes to bail out quickly on non-HTTP data
    // (e.g. encrypted streams falsely sniffed as HTTP/1.1).
    // On success consumes through the delimiter and returns { time, bytes }
    // where bytes excludes the delimiter unless `includeDelimiter` is set.
    // Returns null when incomplete or when the scan cap is exceeded.
    _readUntil(delimiter, maxScan, includeDelimiter) {
        let cIdx = this.chunkIdx;
        let cOffset = this.offset;
        const dLen = delimiter.length;

        let buffer = null;       // Single growing buffer
        let searchFrom = 0;      // Byte offset to start searching from

        while (cIdx < this.chunks.length) {
            const buf = this.chunks[cIdx].bytes;
            const slice = buf.subarray(cOffset);

            if (!buffer) {
                buffer = new Uint8Array(slice);
            } else {
                const newBuf = new Uint8Array(buffer.length + slice.length);
                newBuf.set(buffer);
                newBuf.set(slice, buffer.length);
                buffer = newBuf;
            }

            const start = Math.max(0, searchFrom - (dLen - 1));
            outer: for (let i = start; i <= buffer.length - dLen; i++) {
                for (let j = 0; j < dLen; j++) {
                    if (buffer[i + j] !== delimiter[j]) continue outer;
                }
                const time = this.chunks[this.chunkIdx].time;
                this._consume(i + dLen);
                return { time, bytes: buffer.subarray(0, includeDelimiter ? i + dLen : i) };
            }
            searchFrom = buffer.length;

            if (buffer.length > maxScan) return null;

            cIdx++;
            cOffset = 0;
        }
        return null;
    }

    // Attempt to read until \r\n\r\n.
    _readHeaders() {
        return this._readUntil(CRLFCRLF, MAX_HEADER_SCAN, true);
    }

    _readLine() {
        return this._readUntil(CRLF, MAX_LINE_SCAN, false);
    }

    // Read up to `bodyRemaining` bytes. Group by chunks
    _readLengthBody() {
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
                    const parsed = parseInt(value, 10);
                    if (Number.isFinite(parsed) && parsed >= 0) contentLength = parsed;
                }
            }
        }
        return { firstLine, headers, isChunked, contentLength };
    }

    _finishMessage() {
        this.messages.push(this.currentMessage);
        this.currentMessage = null;
        this.state = this.state === 'FINISHED' ? 'FINISHED' : 'HEADERS';
    }

    _startMessage(headersObj) {
        const meta = this._parseHeaders(headersObj.bytes);
        const isResponse = meta.firstLine.startsWith('HTTP/');
        let status = 0;
        if (isResponse) {
            status = parseInt(meta.firstLine.split(' ')[1], 10) || 0;
        }

        const message = {
            time: headersObj.time,
            firstLine: meta.firstLine,
            headers: meta.headers,
            data: []
        };

        if (isResponse && status >= 100 && status < 200 && status !== 101) {
            // Informational (100 Continue, 103 Early Hints, ...): no body and
            // not paired with a request. Attach to the next final response.
            this.pendingInformational.push(message);
            return;
        }

        this.currentMessage = message;
        if (isResponse && this.pendingInformational.length > 0) {
            message.informational = this.pendingInformational;
            this.pendingInformational = [];
        }

        let noBody = false;
        if (isResponse) {
            const method = (this.requestMethods[this.responseIndex] || '').toUpperCase();
            this.responseIndex++;
            // RFC 9112 §6.3: responses to HEAD and 1xx/204/304 never carry a body.
            if (method === 'HEAD' || status === 204 || status === 304 || status === 101) noBody = true;
            if (method === 'CONNECT' && status >= 200 && status < 300) noBody = true;
        }

        if (isResponse && status === 101) {
            // Switching Protocols — whatever follows is no longer HTTP/1.x
            this.state = 'FINISHED';
            this._finishMessage();
            return;
        }

        if (noBody) {
            this._finishMessage();
        } else if (meta.isChunked) {
            this.state = 'CHUNK_SIZE';
        } else if (meta.contentLength >= 0) {
            this.bodyRemaining = meta.contentLength;
            if (this.bodyRemaining === 0) {
                this._finishMessage();
            } else {
                this.state = 'BODY_LENGTH';
            }
        } else if (isResponse) {
            // Responses without framing are delimited by connection close
            this.state = 'BODY_EOF';
        } else {
            // Requests without Content-Length / Transfer-Encoding have no body
            this._finishMessage();
        }
    }

    parse() {
        while (this.chunkIdx < this.chunks.length && this.state !== 'FINISHED') {
            // Skip zero-length chunks that would stall progress. TLS decryption
            // can produce empty records (alerts, ChangeCipherSpec, close_notify)
            // and TCP reconstruction may emit empty segments from ACK-only packets.
            // Without this guard, _consume(0) is a no-op and body processing
            // states loop forever on the same chunkIdx.
            const chunk = this.chunks[this.chunkIdx];
            if (chunk.bytes.length - this.offset <= 0) {
                this.chunkIdx++;
                this.offset = 0;
                continue;
            }

            if (this.state === 'HEADERS') {
                // Tolerate stray CRLFs between messages (RFC 9112 §2.2)
                const b = chunk.bytes[this.offset];
                if (b === 13 || b === 10) {
                    this._consume(1);
                    continue;
                }
                const headersObj = this._readHeaders();
                if (!headersObj) break; // Incomplete headers
                this._startMessage(headersObj);
            } else if (this.state === 'BODY_LENGTH') {
                const chunks = this._readLengthBody();
                this.currentMessage.data.push(...chunks);
                if (this.bodyRemaining === 0) {
                    this._finishMessage();
                }
            } else if (this.state === 'BODY_EOF') {
                // Read everything remaining
                const avail = chunk.bytes.length - this.offset;
                this.currentMessage.data.push({
                    time: chunk.time,
                    length: avail,
                    bytes: chunk.bytes.subarray(this.offset)
                });
                this._consume(avail);
            } else if (this.state === 'CHUNK_SIZE') {
                const line = this._readLine();
                if (!line) break; // Incomplete
                const text = new TextDecoder('ascii').decode(line.bytes);
                const sizeStr = text.split(';')[0].trim(); // Strip chunk extensions
                if (!/^[0-9a-fA-F]+$/.test(sizeStr)) {
                    // Not valid chunked framing — keep whatever follows as raw
                    // body up to connection close rather than losing it.
                    this.state = 'BODY_EOF';
                    continue;
                }
                const size = parseInt(sizeStr, 16);
                if (size === 0) {
                    this.state = 'CHUNK_TRAILERS';
                } else {
                    this.bodyRemaining = size;
                    this.state = 'CHUNK_DATA';
                }
            } else if (this.state === 'CHUNK_DATA') {
                const chunks = this._readLengthBody();
                this.currentMessage.data.push(...chunks);
                if (this.bodyRemaining === 0) this.state = 'CHUNK_CRLF';
            } else if (this.state === 'CHUNK_CRLF') {
                const line = this._readLine();
                if (!line) break;
                this.state = 'CHUNK_SIZE';
            } else if (this.state === 'CHUNK_TRAILERS') {
                const line = this._readLine();
                if (!line) break;
                if (line.bytes.length === 0) {
                    this._finishMessage();
                } else {
                    const text = new TextDecoder('ascii').decode(line.bytes);
                    const sep = text.indexOf(':');
                    if (sep !== -1) {
                        if (!this.currentMessage.trailers) this.currentMessage.trailers = [];
                        this.currentMessage.trailers.push({ name: text.substring(0, sep).trim(), value: text.substring(sep + 1).trim() });
                    }
                }
            }
        }

        // Stream ended: flush any partially-received message (truncated
        // capture or close-delimited body) so its headers/data aren't lost.
        if (this.currentMessage && this.state !== 'HEADERS') {
            this.messages.push(this.currentMessage);
            this.currentMessage = null;
        }

        return this.messages;
    }
}

const CRLF = new Uint8Array([13, 10]);
const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

function looksLikeResponseStream(chunks) {
    const first = chunks.find(c => c.bytes.length > 0);
    if (!first || first.bytes.length < 5) return false;
    return first.bytes[0] === 0x48 && first.bytes[1] === 0x54 && first.bytes[2] === 0x54 && first.bytes[3] === 0x50 && first.bytes[4] === 0x2F; // "HTTP/"
}

function methodsOf(messages) {
    return messages.filter(m => m.firstLine && !m.firstLine.startsWith('HTTP/')).map(m => m.firstLine.split(' ')[0] || '');
}

export function decodeHttp1(clientChunks, serverChunks) {
    // Requests must be parsed before responses so responses to HEAD can be
    // framed correctly. If the roles look swapped (mid-stream pickup where the
    // "client" flow actually carries responses), parse the other side first.
    const swapped = looksLikeResponseStream(clientChunks) && !looksLikeResponseStream(serverChunks);
    let clientMessages, serverMessages;
    if (swapped) {
        serverMessages = new Http1Parser(serverChunks).parse();
        clientMessages = new Http1Parser(clientChunks, methodsOf(serverMessages)).parse();
    } else {
        clientMessages = new Http1Parser(clientChunks).parse();
        serverMessages = new Http1Parser(serverChunks, methodsOf(clientMessages)).parse();
    }

    return {
        requests: clientMessages,
        responses: serverMessages
    };
}
