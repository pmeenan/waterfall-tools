/**
 * @fileoverview HAR Input Processor
 * Parses raw HAR and Extended HAR payloads, normalizing them strictly into
 * the Waterfall Tools Extended HAR intermediary structure.
 */

/**
 * Normalizes a parsed HAR object into the Extended HAR format.
 * This function is isomorphic and operates synchronously.
 * 
 * @param {Object} rawHar - The raw HAR object payload
 * @returns {import('../core/har-types.js').ExtendedHAR}
 */
export function normalizeHAR(rawHar) {
    const output = {
        log: {
            version: "1.2",
            creator: {
                name: "waterfall-tools",
                version: "1.0.0"
            },
            pages: [],
            entries: []
        }
    };

    if (rawHar && rawHar.log) {
        if (Array.isArray(rawHar.log.pages)) {
            output.log.pages = rawHar.log.pages;
        }

        if (Array.isArray(rawHar.log.entries)) {
            output.log.entries = rawHar.log.entries;
        }
    }

    return output;
}

/**
 * Checks magic bytes to determine if a buffer is gzip compressed.
 * @param {Buffer} buffer 
 * @returns {boolean}
 */
function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export async function processHARFileNode(input, options = {}) {
    const { JSONParser } = await import('@streamparser/json');

    let stream = input;
    let isGz = options.isGz === true;
    let nodeFsStream = null;
    let output = null;

    // Isomorphic workaround for Node 22 Web Stream premature event loop exit bug
    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import('node:fs');
            
            const header = Buffer.alloc(2);
            try {
                const fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            isGz = isGzip(header);
            
            const { Readable } = await import('node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

    if (isGz) {
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }

    output = normalizeHAR(); // Provides generic fallback shell

    const parser = new JSONParser({ 
        paths: ['$.log.pages.*', '$.log.entries.*'], 
        keepStack: false 
    });

    parser.onValue = ({ value }) => {
        if (value && typeof value === 'object') {
            if ('request' in value || 'response' in value || 'time' in value) {
                output.log.entries.push(value);
            } else if ('pageTimings' in value || 'title' in value || 'id' in value) {
                output.log.pages.push(value);
            }
        }
    };
    
    const pipeline = stream.pipeThrough(new TextDecoderStream());
    const reader = pipeline.getReader();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.write(value);
    }
    
    if (options.debug) console.log(`[har.js] Finished parsing HAR string structure. Returning extracted items.`);

    } catch (e) {
        throw e;
    } finally {
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }

    const { buildWaterfallDataFromHar } = await import('../core/har-converter.js');
    return buildWaterfallDataFromHar(output.log, 'har');
}
