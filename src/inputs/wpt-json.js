import { buildWaterfallDataFromHar } from '../core/har-converter.js';

// WebPageTest JSON Input Processor
// Processes natively without node polyfills using purely Web Streams mapping seamlessly
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
    
    const bloatNames = new Set([
        'generated-html', 
        'almanac', 
        'bodies', 
        'response_body', 
        'response_body_almanac', 
        'thumbnails', 
        'images', 
        'videoFrames'
    ]);

    // Copy all metadata natively mapped into Extended Page object
    for (const key of Object.keys(viewData)) {
        if (key !== 'requests' && !bloatNames.has(key)) {
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
                if (!bloatNames.has(key)) {
                    entry['_' + key] = req[key];
                }
            }
            
            har.log.entries.push(entry);
        }
    }
}


function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export async function processWPTFileNode(input, options = {}) {
    const { JSONParser } = await import('@streamparser/json');

    let stream = input;
    let isGz = options.isGz === true;
    let nodeFsStream = null;
    let reader = null;
    let output = null;

    // Isomorphic workaround for Node 22 Web Stream premature event loop exit bug
    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import('node:fs');
            
            const header = new Uint8Array(2);
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

    output = normalizeWPT({ data: { runs: {}, median: {} } }); // Safe fallback shell

    // Utilize native AST interception avoiding massive object stacks reliably traversing manually dropping subsets dynamically natively
    const parser = new JSONParser({ 
        paths: [
            '$.data.runs.*.firstView', 
            '$.data.runs.*.repeatView', 
            '$.data.median.firstView', 
            '$.data.median.repeatView',
            '$.data.bwDown'
        ], 
        keepStack: false // Safely disabled preventing massive V8 allocation cascades, preserving only index mappings dynamically natively.
    });

    const bloatNames = new Set([
        'generated-html', 
        'almanac', 
        'bodies', 
        'response_body', 
        'response_body_almanac', 
        'thumbnails', 
        'images', 
        'videoFrames'
    ]);

    parser.onValue = ({ value, key, parent, stack }) => {
        if (bloatNames.has(key)) return undefined; // Strips heavy blobs entirely during AST population cleanly

        if (key === 'bwDown') {
            output.log._bwDown = value;
            return undefined;
        }

        // Intercept completed views accurately preventing parent AST accumulation correctly natively
        if ((key === 'firstView' || key === 'repeatView') && value && value.requests) {
            let runStr = '1';
            let cachedNum = key === 'repeatView' ? 1 : 0;
            
            // stack: [ { key: "data", ... }, { key: "runs", ... }, { key: "1", ... } ]
            if (stack.length >= 3) {
                const parentType = stack[stack.length - 2].key; // "runs" vs "median"
                if (parentType !== 'median') {
                    // The direct parent is the run index natively 
                    runStr = stack[stack.length - 1].key; 
                } else {
                    runStr = 'median';
                }
            }
            
            processWPTView(value, runStr, cachedNum, output);
            return undefined; // Flushes processed view releasing parent RAM natively
        }
        
        return value;
    };
    
    const pipeline = stream.pipeThrough(new TextDecoderStream());
    reader = pipeline.getReader();
    
    let chunkCount = 0;
    while (true) {
        const { done, value } = await reader.read();
        chunkCount++;
        if (options.debug && chunkCount % 1000 === 0) console.log("Read chunks:", chunkCount);
        if (done) {
            if (options.debug) console.log("Stream Done!");
            break;
        }
        parser.write(value);
    }
    if (options.debug) console.log("Finished WPT loop.");
    
    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }

    // Since streaming parses elements inherently in document order (median can precede runs theoretically),
    // we drop median representations explicitly identically aligning perfectly matching legacy WPT parsing.
    const hasRuns = output.log.pages.some(p => !p.id.includes('_median_'));
    if (hasRuns) {
        output.log.pages = output.log.pages.filter(p => !p.id.includes('_median_'));
        output.log.entries = output.log.entries.filter(e => !e.pageref.includes('_median_'));
    }

    // Assign globally captured bandwidth bounds directly to all remaining valid pages securely natively
    if (output.log._bwDown && output.log._bwDown > 0) {
        output.log.pages.forEach(p => p._bwDown = output.log._bwDown);
    }

    return buildWaterfallDataFromHar(output.log, 'wpt');
}
