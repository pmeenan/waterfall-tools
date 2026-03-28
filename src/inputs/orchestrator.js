import fs from 'node:fs';
import zlib from 'node:zlib';
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
    
    // Netlog
    if (minText.includes('{"constants":') && minText.includes('"logEventTypes":')) {
        return resolve('netlog');
    }
    
    // WebPageTest
    if ((minText.startsWith('{"data":{') || minText.includes('"data":{')) && (minText.includes('"median":') || minText.includes('"runs":'))) {
        return resolve('wpt');
    }
    
    // Chrome Trace
    if (minText.startsWith('{"traceEvents":') || (minText.includes('{"pid":') && minText.includes('"ts":') && minText.includes('"cat":'))) {
        return resolve('chrome-trace');
    }
    if (minText.startsWith('[{"pid":') || minText.startsWith('[{"cat":') || minText.startsWith('[{"name":')) {
        return resolve('chrome-trace');
    }
    
    // CDP
    if (minText.startsWith('[{"method":"') || minText.includes('{"method":"Network.')) {
        return resolve('cdp');
    }
    
    // HAR (HTTP Archive)
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":') || minText.includes('{"log":{"pages":')) {
        return resolve('har');
    }
    
    // Default or unknown
    resolve('unknown');
}

export async function identifyFormat(filePath) {
    if (typeof filePath !== 'string') {
        throw new Error('identifyFormat currently only supports file paths. For streams, pass the format explicitly via options.format.');
    }
    
    return new Promise((resolve, reject) => {
        const header = Buffer.alloc(2);
        try {
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, header, 0, 2, 0);
            fs.closeSync(fd);
        } catch (e) {
            return reject(e);
        }
        
        const isGz = isGzip(header);
        
        let peekSource = fs.createReadStream(filePath);
        let peekStream = peekSource;
        if (isGz) peekStream = peekSource.pipe(zlib.createGunzip());
        
        let result = '';
        peekStream.on('error', (err) => {
            peekSource.destroy();
            reject(err);
        });
        
        peekStream.on('data', (d) => {
            // Check magic bytes for PCAP and PCAPNG
            const buf = typeof d === 'string' ? Buffer.from(d) : d;
            
            if (result.length === 0 && buf.length >= 4) {
                const magic = buf.readUInt32BE(0);
                const magicLE = buf.readUInt32LE(0);
                if (magic === 0xa1b2c3d4 || magic === 0xd4c3b2a1 || magicLE === 0xa1b2c3d4 || magicLE === 0xd4c3b2a1 || magic === 0x0a0d0d0a || magicLE === 0x0a0d0d0a) {
                    peekStream.destroy();
                    peekSource.destroy();
                    return resolve('tcpdump');
                }
            }

            result += buf.toString('utf-8');
            
            // We just need enough characters to sniff the format of JSON files
            if (result.length > 2000) {
                peekStream.destroy();
                peekSource.destroy();
                finishSniffing(result, resolve);
            }
        });
        
        peekStream.on('end', () => {
            peekSource.destroy();
            finishSniffing(result, resolve);
        });
    });
}
