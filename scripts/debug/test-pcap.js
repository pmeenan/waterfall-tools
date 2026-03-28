import { processTcpdumpNode } from '../../src/inputs/tcpdump.js';

async function main() {
    console.log("Processing pcap...");
    const { packets, tcpConnections, udpConnections, dnsLookups } = await processTcpdumpNode('../../Sample/Data/tcpdump/www.google.com-tcpdump.cap.gz');
    console.log(`Parsed ${packets.length} packets.`);
    console.log(`Tracked ${tcpConnections.length} TCP connections.`);
    console.log(`Tracked ${udpConnections.length} UDP connections.`);
    console.log(`Registered ${dnsLookups ? dnsLookups.length : 0} DNS lookups across all transports.`);

    let streamsWithData = 0;
    tcpConnections.forEach(conn => {
        if (conn.clientFlow.contiguousChunks.length > 0 || conn.serverFlow.contiguousChunks.length > 0) {
            streamsWithData++;
        }
    });

    console.log(`TCP Connections with actual payloads: ${streamsWithData}`);

    const udpWithDataConnections = [];
    udpConnections.forEach(conn => {
        if (conn.clientFlow.frames.length > 0 || conn.serverFlow.frames.length > 0) {
            udpWithDataConnections.push(conn);
        }
    });

    console.log(`UDP Connections with actual datagrams: ${udpWithDataConnections.length}`);

    // Print out decrypted chunks
    console.log("\nDecrypted Application Protocols:");
    tcpConnections.forEach((conn, idx) => {
        if (conn.protocol === 'http2') {
            console.log(`Connection ${idx} [HTTP/2]: ${conn.http2.streams.size} active streams tracked.`);
            for (const [id, stream] of conn.http2.streams.entries()) {
                // Ignore empty streams without client request data
                if (stream.headers.client.length === 0) continue;
                console.log(`  Stream ${id}: ${stream.headers.client.length} client headers, ${stream.data.server.length} server DATA frames.`);
                // Print some pseudo-headers if available
                const method = stream.headers.client.find(h => h.name === ':method');
                const path = stream.headers.client.find(h => h.name === ':path');
                const status = stream.headers.server.find(h => h.name === ':status');
                if (method && path) {
                    console.log(`    -> ${method.value} ${path.value}`);
                }
                if (status) {
                    console.log(`    <- HTTP/2 ${status.value}`);
                }
            }
        } else if (conn.protocol === 'http/1.1') {
            console.log(`Connection ${idx} [HTTP/1.1]: ${conn.http.requests.length} requests, ${conn.http.responses.length} responses.`);
            if (conn.http.requests.length > 0) {
                console.log(`  Req 0: ${conn.http.requests[0].firstLine}`);
            }
            if (conn.http.responses.length > 0) {
                console.log(`  Res 0: ${conn.http.responses[0].firstLine} (${conn.http.responses[0].data.length} body chunks)`);
            }
        }
    });

    console.log("\nDecrypted UDP Protocols:");
    udpWithDataConnections.forEach((conn, idx) => {
        if (conn.protocol === 'quic') {
            console.log(`UDP Conn ${idx} [QUIC/HTTP3]: ${conn.quic.length} tracked frames.`);
            const successful1RTT = conn.quic.filter(q => q.type === '1-RTT' && q.http3);
            if (successful1RTT.length > 0) {
                console.log(`  Decrypted 1-RTT streams found!`);
                successful1RTT.forEach((q, qIdx) => {
                    if (qIdx < 3 && q.http3.url) {
                        console.log(`    HTTP/3 -> Method: ${q.http3.method}, URL: ${q.http3.url}`);
                    }
                });
            } else {
                const errs = conn.quic.filter(q => q.error);
                if (errs.length > 0) {
                    console.log(`  Decryption failed... (${errs.length} fragments unreadable)`);
                }
            }
            if (conn.quicParams && conn.quicParams.streams) {
                console.log(`  Reassembled QUIC Streams: ${conn.quicParams.streams.size}`);
            }
        }
    });

    console.log("\nUnified DNS Resolution Map:");
    if (dnsLookups) {
        dnsLookups.forEach((lookup, idx) => {
            console.log(`Lookup ${idx} [${lookup.transport}]: ${lookup.domain} -> [${lookup.ips.join(', ')}] (${lookup.duration.toFixed(2)} ms)`);
        });
    }
}
main().catch(console.error);
