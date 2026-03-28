/**
 * Basic DNS packet parser extracting transaction info, queries, and answers.
 */
export function decodeDns(rawBuffer) {
    if (!rawBuffer) return null;
    const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
    if (buffer.length < 12) return null;

    let offset = 0;
    const transactionId = buffer.readUInt16BE(offset); offset += 2;
    const flags = buffer.readUInt16BE(offset); offset += 2;
    const qdcount = buffer.readUInt16BE(offset); offset += 2;
    const ancount = buffer.readUInt16BE(offset); offset += 2;
    const nscount = buffer.readUInt16BE(offset); offset += 2;
    const arcount = buffer.readUInt16BE(offset); offset += 2;

    const isResponse = (flags & 0x8000) !== 0;

    const result = {
        transactionId,
        isResponse,
        queries: [],
        answers: []
    };

    function readName() {
        let labels = [];
        let jumped = false;
        let jumps = 0;

        while (jumps < 20) {
            if (p >= buffer.length) break;
            const length = buffer[p];
            if (length === 0) {
                p++;
                break; // Root label
            }

            // Pointer
            if ((length & 0xC0) === 0xC0) {
                if (p + 1 >= buffer.length) break;
                if (!jumped) {
                    jumped = true;
                    offset = p + 2;
                }
                const pointer = ((length & 0x3F) << 8) | buffer[p + 1];
                p = pointer;
                jumps++;
                continue;
            }

            // Standard label
            p++;
            if (p + length > buffer.length) break;
            labels.push(buffer.toString('utf8', p, p + length));
            p += length;
        }

        if (!jumped) {
            offset = p;
        }

        return labels.join('.');
    }

    try {
        for (let i = 0; i < qdcount; i++) {
            const name = readName();
            if (offset + 4 > buffer.length) break;
            const type = buffer.readUInt16BE(offset); offset += 2;
            const qclass = buffer.readUInt16BE(offset); offset += 2;
            result.queries.push({ name, type, "class": qclass });
        }

        for (let i = 0; i < ancount; i++) {
            const name = readName();
            if (offset + 10 > buffer.length) break;
            const type = buffer.readUInt16BE(offset); offset += 2;
            const qclass = buffer.readUInt16BE(offset); offset += 2;
            const ttl = buffer.readUInt32BE(offset); offset += 4;
            const rdlength = buffer.readUInt16BE(offset); offset += 2;
            
            if (offset + rdlength > buffer.length) break;

            let address = null;
            if (type === 1) { // A record (IPv4)
                if (rdlength === 4) {
                    address = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
                }
            } else if (type === 28) { // AAAA record (IPv6)
                if (rdlength === 16) {
                    const parts = [];
                    for(let j=0; j<16; j+=2) {
                        parts.push(buffer.readUInt16BE(offset + j).toString(16));
                    }
                    address = parts.join(':');
                }
            } else if (type === 5) { // CNAME
                const oldOffset = offset;
                address = readName();
                offset = oldOffset; // readName modifies offset, revert it for rdlength tracking
            }

            offset += rdlength;

            result.answers.push({ name, type, "class": qclass, ttl, address });
        }
    } catch (e) {
        // Truncated or malformed packet
    }

    return result;
}
