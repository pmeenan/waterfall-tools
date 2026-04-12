/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview HAR Input Processor
 * Parses raw HAR and Extended HAR payloads, normalizing them strictly into
 * the Waterfall Tools Extended HAR intermediary structure.
 */

import { buildWaterfallDataFromHar } from '../core/har-converter.js';

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
    let reader = null;
    let output = null;

    const onProgress = options.onProgress || (() => {});
    const totalBytes = options.totalBytes || 0;

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
    reader = pipeline.getReader();

    onProgress('Parsing HAR...', 0);
    let bytesRead = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        parser.write(value);
        if (totalBytes > 0) onProgress('Parsing HAR...', Math.round((bytesRead / totalBytes) * 90));
    }
    onProgress('Building waterfall...', 90);

    if (options.debug) console.log(`[har.js] Finished parsing HAR string structure. Returning extracted items.`);

    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }

    // Use statically imported buildWaterfallDataFromHar
    return buildWaterfallDataFromHar(output.log, 'har');
}
