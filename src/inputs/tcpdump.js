import fs from 'node:fs';
import zlib from 'node:zlib';
import { PcapParser } from './pcap-parser.js';

export async function processTcpdumpNode(filePath, options = {}) {
    return new Promise((resolve, reject) => {
        const packets = [];
        const parser = new PcapParser((packet) => {
            packets.push(packet);
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

            stream.on('end', () => {
                resolve(packets);
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
