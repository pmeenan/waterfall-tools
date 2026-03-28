import fs from 'node:fs';
import zlib from 'node:zlib';
import { PcapParser } from './pcap-parser.js';
import { TcpReconstructor } from './tcp-reconstructor.js';
import { UdpReconstructor } from './udp-reconstructor.js';
import { decodeProtocol } from './protocol-sniffer.js';
import { decodeUdpProtocol } from './udp-sniffer.js';

export async function processTcpdumpNode(filePath, options = {}) {
    return new Promise((resolve, reject) => {
        const packets = [];
        const tcpReconstructor = new TcpReconstructor();
        const udpReconstructor = new UdpReconstructor();

        const parser = new PcapParser((packet) => {
            packets.push(packet);
            tcpReconstructor.push(packet);
            udpReconstructor.push(packet);
        });

        let inputStream = fs.createReadStream(filePath);
        let sniffing = true;
        
        // Peek at first 2 bytes to check for gzip magic number (1f 8b)
        inputStream.once('data', (chunk) => {
            let stream = inputStream;
            if (chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
                // It's gzipped, we need to restart the stream and pipe it
                inputStream.destroy();
                inputStream = fs.createReadStream(filePath);
                stream = inputStream.pipe(zlib.createGunzip());
                
                stream.on('error', (err) => {
                    inputStream.destroy();
                    reject(err);
                });
            } else {
                // It's not gzipped, pass the chunk to the parser immediately because we just consumed it
                try {
                    parser.push(chunk);
                } catch (err) {
                    inputStream.destroy();
                    return reject(err);
                }
            }

            stream.on('data', (dataChunk) => {
                try {
                    parser.push(dataChunk);
                } catch (err) {
                    stream.destroy();
                    if (stream !== inputStream) inputStream.destroy();
                    reject(err);
                }
            });

            stream.on('end', async () => {
                let keyLogContents = null;
                const pathParts = filePath.split('.');
                // Simple heuristic to find corresponding keylog: .cap.gz -> .key_log.txt.gz
                // E.g. amazon1.cap.gz -> amazon1.key_log.txt.gz
                const keyLogPath = filePath.replace('.cap.gz', '.key_log.txt.gz');
                
                try {
                    let keyLogStream = fs.createReadStream(keyLogPath);
                    if (keyLogPath.endsWith('.gz')) {
                        keyLogStream = keyLogStream.pipe(zlib.createGunzip());
                    }
                    const chunks = [];
                    for await (const chunk of keyLogStream) {
                        chunks.push(chunk);
                    }
                    keyLogContents = Buffer.concat(chunks).toString('utf8');
                } catch (e) {
                    // It is completely valid for a keylog to not exist.
                }

                let keyLogMap = null;
                if (keyLogContents) {
                    const { TlsKeyLog } = await import('./tls-keylog.js');
                    keyLogMap = new TlsKeyLog();
                    keyLogMap.parseString(keyLogContents);
                }

                const tcpConnections = tcpReconstructor.getConnections();
                
                if (keyLogMap) {
                    const { TlsDecoder } = await import('./tls-decoder.js');
                    
                    for (const conn of tcpConnections) {
                        const decoder = new TlsDecoder(keyLogMap);
                        
                        // Feed client packets
                        for (let chunk of conn.clientFlow.contiguousChunks) {
                            decoder.push(0, chunk.bytes, chunk.time);
                        }
                        // Feed server packets
                        for (let chunk of conn.serverFlow.contiguousChunks) {
                            decoder.push(1, chunk.bytes, chunk.time);
                        }

                        // If decryption succeeded (or produced anything), we replace the payload chunks
                        const decClient = decoder.getDecryptedChunks(0);
                        if (decClient.length > 0) {
                            conn.clientFlow.contiguousChunks = decClient;
                        }
                        
                        const decServer = decoder.getDecryptedChunks(1);
                        if (decServer.length > 0) {
                            conn.serverFlow.contiguousChunks = decServer;
                        }
                    }
                }
                
                // Decode protocols
                for (const conn of tcpConnections) {
                    try {
                        decodeProtocol(conn);
                    } catch (e) {
                        console.error("Protocol Decoded Error:", e);
                    }
                }
                
                const udpConnections = udpReconstructor.getConnections();
                console.log(`[tcpdump.js] Start routing ${udpConnections.length} UDP connections`);
                let udpCount = 0;
                for (const conn of udpConnections) {
                    try {
                        decodeUdpProtocol(conn, keyLogMap);
                        udpCount++;
                    } catch (e) {
                         console.error("UDP Decode Error:", e);
                    }
                }
                console.log(`[tcpdump.js] Successfully verified ${udpCount} UDP connections`);

                resolve({
                    packets: packets,
                    tcpConnections: tcpConnections,
                    udpConnections: udpConnections
                });
            });

            stream.on('error', (err) => {
                if (stream !== inputStream) inputStream.destroy();
                reject(err);
            });
        });

        inputStream.on('error', (err) => {
            reject(err);
        });
    });
}
