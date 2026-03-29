/**
 * Basic DNS packet parser extracting transaction info, queries, and answers.
 */
export function decodeDns(rawBuffer) {
    if (!rawBuffer) return null;
    const buffer = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer);
    if (buffer.length < 12) return null;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    let offset = 0;
    const transactionId = view.getUint16(offset, false); offset += 2;
    const flags = view.getUint16(offset, false); offset += 2;
    const qdcount = view.getUint16(offset, false); offset += 2;
    const ancount = view.getUint16(offset, false); offset += 2;
    const nscount = view.getUint16(offset, false); offset += 2;
    const arcount = view.getUint16(offset, false); offset += 2;

    const isResponse = (flags & 0x8000) !== 0;

    const result = {
        transactionId,
        isResponse,
        queries: [],
        answers: []
    };

    const decoder = new TextDecoder('utf8');

    function readName() {
        let p = offset;
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

            p++;
            if (p + length > buffer.length) break;
            labels.push(decoder.decode(buffer.subarray(p, p + length)));
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
            const type = view.getUint16(offset, false); offset += 2;
            const qclass = view.getUint16(offset, false); offset += 2;
            result.queries.push({ name, type, "class": qclass });
        }

        for (let i = 0; i < ancount; i++) {
            const name = readName();
            if (offset + 10 > buffer.length) break;
            const type = view.getUint16(offset, false); offset += 2;
            const qclass = view.getUint16(offset, false); offset += 2;
            const ttl = view.getUint32(offset, false); offset += 4;
            const rdlength = view.getUint16(offset, false); offset += 2;
            
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
                        parts.push(view.getUint16(offset + j, false).toString(16));
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
