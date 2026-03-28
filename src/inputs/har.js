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

/**
 * Node.js optimized streaming parser for massive HAR payloads.
 * Utilizes `stream-json` to selectively assemble the object without
 * buffering the entire uncompressed string in V8 heap memory.
 * 
 * @param {string} filePath - Path to the HAR file (.har or .har.gz)
 * @returns {Promise<import('../core/har-types.js').ExtendedHAR>}
 */
export async function processHARFileNode(input, options = {}) {
    const fs = await import('node:fs');
    const zlib = await import('node:zlib');
    const streamJson = (await import('stream-json')).default;
    const Assembler = (await import('stream-json/assembler.js')).default;

    return new Promise((resolve, reject) => {
        let isGz = false;
        let fileStream;

        if (typeof input === 'string') {
            const header = Buffer.alloc(2);
            let fd;
            try {
                fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                return reject(e);
            }
            isGz = isGzip(header);
            fileStream = fs.createReadStream(input);
        } else {
            fileStream = input;
            isGz = options.isGz === true;
        }
        
        let readStream = fileStream;
        if (isGz) {
            readStream = fileStream.pipe(zlib.createGunzip());
        }

        // Initialize the streaming JSON parser
        const jsonStream = readStream.pipe(streamJson());
        
        // Connect the Assembler to construct the object cleanly.
        // Because it avoids allocating massive strings prior to parsing,
        // this keeps peak memory utilization vastly lower than JSON.parse().
        const assembler = Assembler.connectTo(jsonStream);

        assembler.on('done', asm => {
            resolve(normalizeHAR(asm.current));
            if (typeof input === 'string') {
                fileStream.destroy();
            }
        });

        jsonStream.on('error', reject);
        readStream.on('error', reject);
        fileStream.on('error', reject);
    });
}
