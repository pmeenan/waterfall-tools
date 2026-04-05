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
// Exported so wptagent.js can construct the single unified HAR locally
export function getBaseWptHar() {
    return {
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
}

export function normalizeWPT(rawData) {
    const har = getBaseWptHar();

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
        },
        _run: parseInt(runStr, 10),
        _cached: cachedNum
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
            if (key === 'utilization') {
                const stdUtil = {};
                for (const uKey of Object.keys(viewData.utilization)) {
                    const uVal = viewData.utilization[uKey];
                    let dataDict = null;
                    let maxVal = 1;
                    
                    // WPT JSON format natively bundles [ {dataDict}, maxVal, avgVal ] OR { data: {dataDict}, max: maxVal, count: avgVal }
                    if (Array.isArray(uVal) && uVal.length >= 2 && typeof uVal[0] === 'object' && !Array.isArray(uVal[0])) {
                        dataDict = uVal[0];
                        maxVal = Math.max(1, parseFloat(uVal[1]) || 1);
                    } else if (uVal && typeof uVal === 'object' && uVal.data && typeof uVal.data === 'object') {
                        dataDict = uVal.data;
                        maxVal = Math.max(1, parseFloat(uVal.max) || 1);
                    }
                    
                    if (dataDict) {
                        const arr = [];
                        let rawPts = Object.entries(dataDict).map(([k, v]) => ({ ts: parseFloat(k), val: parseFloat(v) }));
                        rawPts.sort((a, b) => a.ts - b.ts);
                        
                        if (uKey === 'bw') {
                            const wireBps = (har.log._bwDown || viewData.bwDown || 0) * 1000.0;
                            const limit = wireBps > 0 ? wireBps : maxVal;
                            
                            let intervalMs = 100;
                            if (rawPts.length > 1) {
                                intervalMs = rawPts[1].ts - rawPts[0].ts;
                                if (intervalMs <= 0) intervalMs = 100;
                            }
                            
                            if (wireBps > 0) {
                                for (let i = rawPts.length - 1; i >= 0; i--) {
                                    if (rawPts[i].val > limit) {
                                        let excess = rawPts[i].val - limit;
                                        rawPts[i].val = limit;
                                        if (i > 0) {
                                            rawPts[i-1].val += excess;
                                        } else {
                                            rawPts.unshift({ ts: rawPts[0].ts - intervalMs, val: excess });
                                            i++;
                                        }
                                    }
                                }
                                maxVal = limit;
                            }
                        }
                        
                        for (const pt of rawPts) {
                            const pct = (pt.val / maxVal) * 100.0;
                            arr.push([pt.ts, pct]);
                        }
                        
                        arr.max = maxVal; // Preserve the original absolute max bounding cleanly (for Node)
                        stdUtil[uKey] = arr;
                        stdUtil[uKey + 'Max'] = maxVal; // Safe property for Web Worker / structured cloning (for Browser)
                    } else {
                        stdUtil[uKey] = uVal;
                    }
                }
                page['_utilization'] = stdUtil;
            } else if (key === 'chromeUserTiming' && Array.isArray(viewData[key])) {
                viewData[key].forEach(event => {
                    if (event.name && event.time !== undefined) {
                        if (event.name === 'LargestContentfulPaint' && !page['_LargestContentfulPaint']) {
                            page['_LargestContentfulPaint'] = event.time;
                        }
                        if (event.name === 'firstContentfulPaint' && !page['_firstContentfulPaint']) {
                            page['_firstContentfulPaint'] = event.time;
                        }
                    }
                });
                page['_' + key] = viewData[key];
            } else {
                page['_' + key] = viewData[key];
            }
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
            if (req.created !== undefined && req.created >= 0) {
                reqStartedDateTime = new Date(dateUnix * 1000 + parseFloat(req.created)).toISOString();
            } else if (req.load_start !== undefined) {
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
            const fs = await import(/* @vite-ignore */ 'node:fs');
            
            const header = new Uint8Array(2);
            try {
                const fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            isGz = isGzip(header);
            
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
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
            '$.data.id',
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

        if (key === 'id' && typeof value === 'string') {
            if (!output.log._id) output.log._id = value;
            return value;
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

/**
 * Processes a flat WPT json stream typically found in wptagent devtools_requests.json.gz files directly.
 * Appends into a shared HAR output.
 */
export async function processWPTFlatStreamNode(input, runStr, cachedNum, outputHar, options = {}) {
    const { JSONParser } = await import('@streamparser/json');

    let stream = input;
    if (options.isGz) {
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }

    const viewData = {};
    const parser = new JSONParser({ 
        paths: ['$.pageData', '$.requests'], 
        keepStack: false
    });

    parser.onValue = ({ value, key }) => {
        if (key === 'pageData') {
            Object.assign(viewData, value);
            return undefined;
        } else if (key === 'requests') {
            viewData.requests = value;
            processWPTView(viewData, runStr, cachedNum, outputHar);
            return undefined;
        }
        return value;
    };

    const pipeline = stream.pipeThrough(new TextDecoderStream());
    const reader = pipeline.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.write(value);
        }
    } finally {
        reader.releaseLock();
    }
}

export function formatWptUtilization(rawUtilization, bwDown = 0) {
    const stdUtil = {};
    for (const uKey of Object.keys(rawUtilization)) {
        const uVal = rawUtilization[uKey];
        let dataDict = null;
        let maxVal = 1;
        
        if (Array.isArray(uVal) && uVal.length >= 2 && typeof uVal[0] === 'object' && !Array.isArray(uVal[0])) {
            dataDict = uVal[0];
            maxVal = Math.max(1, parseFloat(uVal[1]) || 1);
        } else if (uVal && typeof uVal === 'object' && uVal.data && typeof uVal.data === 'object') {
            dataDict = uVal.data;
            maxVal = Math.max(1, parseFloat(uVal.max) || 1);
        }
        
        if (dataDict) {
            const arr = [];
            let rawPts = Object.entries(dataDict).map(([k, v]) => ({ ts: parseFloat(k), val: parseFloat(v) }));
            rawPts.sort((a, b) => a.ts - b.ts);
            
            if (uKey === 'bw') {
                const wireBps = bwDown * 1000.0;
                const limit = wireBps > 0 ? wireBps : maxVal;
                
                let intervalMs = 100;
                if (rawPts.length > 1) {
                    intervalMs = rawPts[1].ts - rawPts[0].ts;
                    if (intervalMs <= 0) intervalMs = 100;
                }
                
                if (wireBps > 0) {
                    for (let i = rawPts.length - 1; i >= 0; i--) {
                        if (rawPts[i].val > limit) {
                            let excess = rawPts[i].val - limit;
                            rawPts[i].val = limit;
                            if (i > 0) {
                                rawPts[i-1].val += excess;
                            } else {
                                rawPts.unshift({ ts: rawPts[0].ts - intervalMs, val: excess });
                                i++;
                            }
                        }
                    }
                    maxVal = limit;
                }
            }
            
            for (const pt of rawPts) {
                const pct = (pt.val / maxVal) * 100.0;
                arr.push([pt.ts, pct]);
            }
            
            arr.max = maxVal;
            stdUtil[uKey] = arr;
            stdUtil[uKey + 'Max'] = maxVal;
        } else {
            stdUtil[uKey] = uVal;
        }
    }
    return stdUtil;
}

