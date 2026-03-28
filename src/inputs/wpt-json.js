import fs from 'node:fs';
import zlib from 'node:zlib';
import streamJson from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import { Transform } from 'node:stream';

/**
 * Normalizes a processed WebPageTest JSON object into the Extended HAR format.
 * This function translates the WPT format to standard HAR strictly.
 * 
 * @param {Object} rawData - The parsed WebPageTest JSON payload
 * @returns {import('../core/har-types.js').ExtendedHAR}
 */
export function normalizeWPT(rawData) {
    const har = {
        log: {
            version: '1.2',
            creator: {
                name: 'waterfall-tools',
                version: '1.0.0'
            },
            pages: [],
            entries: []
        }
    };

    const data = rawData.data || rawData;

    if (data.runs) {
        for (const runId of Object.keys(data.runs)) {
            const run = data.runs[runId];
            if (run.firstView) {
                processWPTView(run.firstView, runId, 0, har);
            }
            if (run.repeatView) {
                processWPTView(run.repeatView, runId, 1, har);
            }
        }
    } else if (data.median) {
        if (data.median.firstView) {
            processWPTView(data.median.firstView, '1', 0, har);
        }
        if (data.median.repeatView) {
            processWPTView(data.median.repeatView, '1', 1, har);
        }
    }

    return har;
}

function processWPTView(viewData, runStr, cachedNum, har) {
    const pageId = `page_${runStr}_${cachedNum}_1`;
    const dateUnix = viewData.date || (Date.now() / 1000); 
    const startedDateTime = new Date(dateUnix * 1000).toISOString();
    
    // Construct the Page object
    const page = {
        id: pageId,
        title: `Run ${runStr}, ${cachedNum ? 'Repeat View' : 'First View'} for ${viewData.URL || ''}`,
        startedDateTime,
        pageTimings: {
            onLoad: viewData.docTime !== undefined ? viewData.docTime : -1,
            onContentLoad: -1,
            _startRender: viewData.render !== undefined ? viewData.render : -1
        }
    };
    
    // Copy all metadata natively mapped into Extended Page object
    for (const key of Object.keys(viewData)) {
        if (key !== 'requests') {
            page['_' + key] = viewData[key];
        }
    }
    har.log.pages.push(page);
    
    // Construct Entries
    if (Array.isArray(viewData.requests)) {
        for (const req of viewData.requests) {
            let blocked = -1;
            if (req.created >= 0) {
                if (req.dns_start >= req.created) blocked = req.dns_start - req.created;
                else if (req.connect_start >= req.created) blocked = req.connect_start - req.created;
                else if (req.ssl_start >= req.created) blocked = req.ssl_start - req.created;
                else if (req.ttfb_start >= req.created) blocked = req.ttfb_start - req.created;
            }
            const dns = req.dns_ms !== undefined ? req.dns_ms : -1;
            let connect = -1;
            if (req.connect_ms !== undefined) {
                connect = req.connect_ms;
                if (req.ssl_ms > 0) connect += req.ssl_ms;
            }
            const ssl = req.ssl_ms !== undefined ? req.ssl_ms : -1;
            const wait = req.ttfb_ms !== undefined ? req.ttfb_ms : -1;
            const receive = req.download_ms !== undefined ? req.download_ms : -1;
            
            let time = 0;
            if (blocked > 0) time += blocked;
            if (dns > 0) time += dns;
            if (connect > 0) time += connect; 
            if (wait > 0) time += wait;
            if (receive > 0) time += receive;
            
            if (req.all_ms !== undefined) {
                time = req.all_ms;
            }
            
            let reqStartedDateTime = startedDateTime;
            if (req.load_start !== undefined) {
                reqStartedDateTime = new Date(dateUnix * 1000 + parseFloat(req.load_start)).toISOString();
            }

            const reqHeaders = []; 
            if (req.headers && req.headers.request) {
                for (const h of req.headers.request) {
                    const colon = h.indexOf(':');
                    if (colon > 0) {
                        reqHeaders.push({name: h.substring(0,colon).trim(), value: h.substring(colon+1).trim()});
                    }
                }
            }
            
            const resHeaders = [];
            if (req.headers && req.headers.response) {
                for (const h of req.headers.response) {
                    const colon = h.indexOf(':');
                    if (colon > 0) {
                        resHeaders.push({name: h.substring(0,colon).trim(), value: h.substring(colon+1).trim()});
                    }
                }
            }

            const urlStr = req.full_url || '';

            const entry = {
                pageref: pageId,
                startedDateTime: reqStartedDateTime,
                time: time,
                request: {
                    method: req.method || 'GET',
                    url: urlStr,
                    httpVersion: req.protocol || '',
                    headersSize: -1,
                    bodySize: -1,
                    cookies: [],
                    headers: reqHeaders,
                    queryString: []
                },
                response: {
                    status: req.responseCode !== undefined ? parseInt(req.responseCode) : -1,
                    statusText: '',
                    httpVersion: req.protocol || '',
                    headersSize: -1,
                    bodySize: req.objectSize !== undefined ? parseInt(req.objectSize) : -1,
                    headers: resHeaders,
                    cookies: [],
                    content: {
                        size: req.objectSize !== undefined ? parseInt(req.objectSize) : -1,
                        mimeType: req.contentType || ''
                    },
                    redirectURL: ''
                },
                cache: {},
                timings: {
                    blocked,
                    dns,
                    connect,
                    ssl,
                    send: 0,
                    wait,
                    receive
                },
                _run: parseInt(runStr, 10),
                _cached: cachedNum
            };
            
            // Map custom properties natively
            for (const key of Object.keys(req)) {
                entry['_' + key] = req[key];
            }
            
            har.log.entries.push(entry);
        }
    }
}

/**
 * Custom Transform Stream to strip massively bloated telemetry and payloads explicitly at token layer,
 * preventing V8 from running out of heap memory prior to Object assembly operations functionally.
 */
class PruneBloatFilter extends Transform {
    constructor(options) {
        super({ objectMode: true, ...options });
        // The list of payload keys that we discard blindly to preserve memory constraints
        this.ignoreKeys = new Set([
            'generated-html', 
            'almanac', 
            'bodies', 
            'response_body', 
            'response_body_almanac', 
            'thumbnails', 
            'images', 
            'videoFrames'
        ]);
        this.ignoreDepth = 0;
        this.ignoreKey = false;
        this.ignoreNesting = 0;
    }

    _transform(chunk, encoding, callback) {
        if (this.ignoreDepth === 0) {
            if (chunk.name === 'keyValue' && this.ignoreKeys.has(chunk.value)) {
                this.ignoreDepth = 1;
                this.ignoreKey = true; // Wait for the subsequent value token natively
                return callback();
            }
            this.push(chunk);
            return callback();
        }

        // Inside ignored boundary evaluation
        if (this.ignoreKey) {
            this.ignoreKey = false;
            // Intercept compound arrays or string blobs
            if (chunk.name === 'startObject' || chunk.name === 'startArray' || chunk.name === 'startString') {
                this.ignoreNesting = 1;
            } else {
                // Scalar primitive drops out automatically cleanly 
                this.ignoreDepth = 0;
            }
            return callback();
        }

        // Track balanced token levels seamlessly
        if (chunk.name === 'startObject' || chunk.name === 'startArray' || chunk.name === 'startString') {
            this.ignoreNesting++;
        } else if (chunk.name === 'endObject' || chunk.name === 'endArray' || chunk.name === 'endString') {
            this.ignoreNesting--;
            if (this.ignoreNesting === 0) {
                this.ignoreDepth = 0; // End of ignored chunk
            }
        }
        
        callback();
    }
}

function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Processes a massive WebPageTest JSON file iteratively converting natively.
 * Wraps custom tokens keeping RAM low seamlessly before constructing memory map.
 * 
 * @param {string} filePath - Path to WPT json file
 * @returns {Promise<import('../core/har-types.js').ExtendedHAR>}
 */
export async function processWPTFileNode(input, options = {}) {
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

        // Tokenize inherently
        const jsonStream = readStream.pipe(streamJson());
        
        // Scrub massively heavy WPT attributes
        const pruner = jsonStream.pipe(new PruneBloatFilter());
        
        // Assemble cleansed JSON cleanly 
        const assembler = Assembler.connectTo(pruner);

        assembler.on('done', asm => {
            try {
                const har = normalizeWPT(asm.current);
                resolve(har);
                if (typeof input === 'string') {
                    fileStream.destroy();
                }
            } catch (err) {
                reject(err);
            }
        });

        jsonStream.on('error', reject);
        pruner.on('error', reject);
        readStream.on('error', reject);
        fileStream.on('error', reject);
    });
}
