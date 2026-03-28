import { decodeDns } from './dns-decoder.js';
import { decodeQuic } from './quic-decoder.js';

export function decodeUdpProtocol(conn, keyLog) {
    // Collect and order all 2-way UDP frames chronologically
    const allFrames = conn.clientFlow.frames.concat(conn.serverFlow.frames).sort((a,b) => a.time - b.time);

    if (allFrames.length === 0) return;

    // Check port mapping
    if (conn.serverPort === 53 || conn.clientPort === 53) {
        conn.protocol = 'dns';
        conn.dns = [];
        
        for (const chunk of allFrames) {
            const parsed = decodeDns(chunk.bytes);
            if (parsed) {
                // To determine direction, check if the frame originally belonged to the client flow
                const isClient = conn.clientFlow.frames.includes(chunk);
                conn.dns.push({
                    time: chunk.time,
                    direction: isClient ? 'request' : 'response',
                    ...parsed
                });
            }
        }
    } else if (conn.serverPort === 443 || conn.clientPort === 443) {
        // Quick sniff for QUIC frame format
        const firstByte = allFrames[0].bytes[0];
        
        // Is it a QUIC packet? (Valid QUIC has highest bit 0x80 or 0x40)
        // Note: 0x80 = Long header, 0x40 = Short header.
        if ((firstByte & 0xC0) === 0xC0 || (firstByte & 0x40) === 0x40) {
            conn.protocol = 'quic';
            
            // Execute the highly complex native parser
            try {
                const processedFrames = allFrames.map(chunk => ({
                    ...chunk,
                    isClient: conn.clientFlow.frames.includes(chunk)
                }));
                conn.quic = decodeQuic(processedFrames, conn.clientPort, keyLog);
            } catch (e) {
                console.error(`[UDP Sniffer] Failed to natively decode QUIC link id ${conn.id}:`, e);
            }
        }
    } else {
        conn.protocol = 'unknown';
    }
}
