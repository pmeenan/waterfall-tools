import { TcpReconstructor } from '../../src/inputs/tcp-reconstructor.js';

function makePacket(srcPort, dstPort, seq, payloadStr, flags = {}) {
    return {
        time: Date.now() / 1000,
        ip: { srcIP: '1.2.3.4', dstIP: '5.6.7.8' },
        transport: {
            type: 'TCP',
            srcPort,
            dstPort,
            seq,
            flags: Object.assign({ SYN: false, FIN: false, RST: false }, flags)
        },
        payload: payloadStr ? Buffer.from(payloadStr) : null
    };
}

const rc = new TcpReconstructor();

// SYN
rc.push(makePacket(1000, 80, 100, null, { SYN: true }));
// Payload 1: seq 101, len 5
rc.push(makePacket(1000, 80, 101, "Hello"));
// Out of order Payload 3: seq 111, len 6
rc.push(makePacket(1000, 80, 111, " World"));
// Deduplicate 1
rc.push(makePacket(1000, 80, 101, "Hello"));
// Overlapping Payload 2: seq 104, len 7
rc.push(makePacket(1000, 80, 104, "lo There"));

const connections = rc.getConnections();
console.log("Connections:", connections.length);
const clientFlow = connections[0].clientFlow;
console.log("Contiguous Chunks:");
clientFlow.contiguousChunks.forEach(c => console.log(`[${c.seq}] ${c.bytes.toString()}`));
console.log("Diagnostics:", clientFlow.diagnostics);
console.log("All Frames duplicated:", clientFlow.allFrames.filter(c => c.duplicate).map(c => `Ignored ${c.duplicateBytes} bytes from seq ${c.seq}`));
