import { processHARFileNode } from './har.js';
import { processWPTFileNode } from './wpt-json.js';
import { processCDPFileNode } from './cdp.js';
import { processChromeTraceFileNode } from './chrome-trace.js';
import { processNetlogFileNode } from './netlog.js';
import { processTcpdumpNode } from './tcpdump.js';

export const parsers = {
    'har': processHARFileNode,
    'wpt': processWPTFileNode,
    'cdp': processCDPFileNode,
    'chrome-trace': processChromeTraceFileNode,
    'netlog': processNetlogFileNode,
    'tcpdump': processTcpdumpNode
};

function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function finishSniffing(text, resolve) {
    const minText = text.replace(/\s/g, '');
    
    if (minText.includes('{"constants":') && minText.includes('"logEventTypes":')) return resolve('netlog');
    if ((minText.startsWith('{"data":{') || minText.includes('"data":{')) && (minText.includes('"median":') || minText.includes('"runs":'))) return resolve('wpt');
    if (minText.startsWith('{"traceEvents":') || (minText.includes('{"pid":') && minText.includes('"ts":') && minText.includes('"cat":'))) return resolve('chrome-trace');
    if (minText.startsWith('[{"pid":') || minText.startsWith('[{"cat":') || minText.startsWith('[{"name":')) return resolve('chrome-trace');
    if (minText.startsWith('[{"method":"') || minText.includes('{"method":"Network.')) return resolve('cdp');
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":') || minText.includes('{"log":{"pages":')) return resolve('har');
    
    resolve('unknown');
}

export async function identifyFormat(filePath) {
    if (typeof filePath !== 'string') {
        throw new Error('identifyFormat currently only supports file paths. For streams, pass the format explicitly via options.format.');
    }
    
    // Dynamically import node modules so browser bundle doesn't crash if explicitly bypassing node paths
    const fs = await import('node:fs');
    
    // Read up to 64KB for format sniffing
    const buffer = Buffer.alloc(65536);
    let fd, bytesRead;
    try {
        fd = fs.openSync(filePath, 'r');
        bytesRead = fs.readSync(fd, buffer, 0, 65536, 0);
        fs.closeSync(fd);
    } catch (e) {
        throw e;
    }
    
    const buf = buffer.subarray(0, bytesRead);
    const result = await identifyFormatFromBuffer(buf);
    return result.format;
}

export async function identifyFormatFromBuffer(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const isGz = isGzip(buf);
    
    let textBuf = buf;
    if (isGz) {
        textBuf = await new Promise(async (resolve) => {
            try {
                const ds = new DecompressionStream('gzip');
                const writer = ds.writable.getWriter();
                writer.write(buf.subarray(0, Math.min(buf.length, 65536))).catch(() => {});
                writer.close().catch(() => {});
                
                const reader = ds.readable.getReader();
                let sniffed = Buffer.alloc(0);
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    sniffed = Buffer.concat([sniffed, Buffer.from(value)]);
                    if (sniffed.length >= 4000) {
                        try { await reader.cancel(); } catch (e) {}
                        break;
                    }
                }
                resolve(sniffed.length > 0 ? sniffed : buf);
            } catch (err) {
                // Return gracefully if stream aborts randomly
                resolve(buf);
            }
        });
    }
    
    if (textBuf.length >= 4) {
        const magic = textBuf.readUInt32BE(0);
        const magicLE = textBuf.readUInt32LE(0);
        if ([0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magic) || [0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magicLE)) {
            return { format: 'tcpdump', isGz };
        }
    }

    return new Promise((resolve) => {
        const textToSniff = textBuf.subarray(0, 4000).toString('utf-8');
        finishSniffing(textToSniff, (format) => resolve({ format, isGz }));
    });
}
