const concatUint8Arrays = (arrays) => {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const res = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        res.set(arr, offset);
        offset += arr.length;
    }
    return res;
};

function indexOfSequence(buffer, seq) {
    if (seq.length === 0) return 0;
    outer: for (let i = 0; i <= buffer.length - seq.length; i++) {
        for (let j = 0; j < seq.length; j++) {
            if (buffer[i + j] !== seq[j]) continue outer;
        }
        return i;
    }
    return -1;
}

const CRLF2 = new Uint8Array([13, 10, 13, 10]);

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

    // Attempt to read until \r\n\r\n
    _readHeaders() {
        let matchIdx = -1;
        let cIdx = this.chunkIdx;
        let cOffset = this.offset;
        
        let accumulator = [];
        let totalLen = 0;

        while (cIdx < this.chunks.length) {
            const buf = this.chunks[cIdx].bytes;
            const avail = buf.length - cOffset;
            accumulator.push(buf.subarray(cOffset));
            totalLen += avail;
            
            // Check if we have \r\n\r\n
            const concatBuf = concatUint8Arrays(accumulator);
            let idx = indexOfSequence(concatBuf, CRLF2);
            if (idx !== -1) {
                // Found boundaries
                const headersRaw = concatBuf.subarray(0, idx + 4);
                
                // Now consume this exact amount from the actual stream
                const time = this.chunks[this.chunkIdx].time; // Time of first chunk 
                this._consume(idx + 4);
                
                return { time, bytes: headersRaw };
            }

            cIdx++;
            cOffset = 0;
        }
        return null;
    }

    // Read exactly n bytes for Content-Length body. Group by chunks
    _readLengthBody(len) {
        let extractedChunks = [];
        while (this.bodyRemaining > 0 && this.chunkIdx < this.chunks.length) {
            const time = this.chunks[this.chunkIdx].time;
            const c = this.chunks[this.chunkIdx].bytes;
            const avail = c.length - this.offset;
            
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
        
        let headers = [];
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
