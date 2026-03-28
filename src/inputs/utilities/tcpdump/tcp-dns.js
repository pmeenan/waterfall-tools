import { decodeDns } from './dns-decoder.js';

export function decodeTcpDns(conn, dnsRegistry) {
    conn.protocol = 'dns';
    conn.dns = [];

    const processSide = (flow, isClient) => {
        if (!flow || flow.contiguousChunks.length === 0) return;

        // Concatenate all fragments sequentially into a single unified continuous stream buffer
        const totalLength = flow.contiguousChunks.reduce((acc, c) => acc + c.bytes.length, 0);
        if (totalLength < 2) return;

        const fullBuffer = Buffer.alloc(totalLength);
        let offset = 0;
        
        // Build an index map mapping absolute byte offsets to originating PCAP packet timestamps
        const timeMap = [];
        flow.contiguousChunks.forEach(c => {
            c.bytes.copy(fullBuffer, offset);
            timeMap.push({ start: offset, end: offset + c.bytes.length, time: c.time });
            offset += c.bytes.length;
        });

        // Resolve exact packet timing based on byte offset
        const resolveTime = (targetOffset) => {
            const block = timeMap.find(m => targetOffset >= m.start && targetOffset < m.end);
            return block ? block.time : timeMap[0].time;
        };

        let p = 0;
        while (p + 2 <= fullBuffer.length) {
            // Standard TCP DNS injects a 2 byte length parameter directly prior to normal RFC 1035 payloads
            const msgLength = fullBuffer.readUInt16BE(p);
            
            // Reassembly fracture protection bounds
            if (p + 2 + msgLength > fullBuffer.length) {
                break;
            }
            
            const dnsPayload = fullBuffer.subarray(p + 2, p + 2 + msgLength);
            const parsed = decodeDns(dnsPayload);
            
            if (parsed) {
                const packetTime = resolveTime(p);
                const metadata = { type: 'TCP', ip: isClient ? conn.clientIp : conn.serverIp };
                
                if (!parsed.isResponse) {
                    dnsRegistry.addRequest(parsed.transactionId, packetTime, parsed.queries, metadata);
                } else {
                    dnsRegistry.addResponse(parsed.transactionId, packetTime, parsed.answers, metadata);
                }

                conn.dns.push({
                    time: packetTime,
                    direction: isClient ? 'request' : 'response',
                    ...parsed
                });
            }
            
            p += (2 + msgLength);
        }
    };

    // Evaluate client-side requests 
    processSide(conn.clientFlow, true);
    // Evaluate server-side responses
    processSide(conn.serverFlow, false);
}
