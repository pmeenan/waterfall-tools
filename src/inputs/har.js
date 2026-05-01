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

import { JSONParser } from '@streamparser/json';
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

/**
 * Normalize chrome-har / Browsertime / sitespeed.io page-timing extensions
 * onto the canonical page-root field names the renderer reads. The HAR 1.2
 * spec only mandates the underscore prefix on extensions, not their
 * location, so a large class of producers nests them inside
 * `pages[].pageTimings.*` instead of on the page root. Doing the remap at
 * import keeps the renderer dealing with a single canonical layout.
 *
 * Page-root values always win on conflict — the renderer's existing
 * producer convention is preserved when both sources are populated.
 *
 * @param {Object} page  HAR page object (mutated in place).
 */
function liftPageTimingsExtensions(page) {
    const pt = page && page.pageTimings;
    if (!pt || typeof pt !== 'object') return;

    // Named numeric extensions. chrome-har emits lowercase
    // `_largestContentfulPaint`; the renderer's canonical is
    // `_LargestContentfulPaint` with capital L.
    if (pt._firstPaint != null && page._render == null) {
        page._render = pt._firstPaint;
    }
    if (pt._firstContentfulPaint != null && page._firstContentfulPaint == null) {
        page._firstContentfulPaint = pt._firstContentfulPaint;
    }
    if (pt._largestContentfulPaint != null && page._LargestContentfulPaint == null) {
        page._LargestContentfulPaint = pt._largestContentfulPaint;
    }
    if (pt._domInteractiveTime != null && page._domInteractive == null) {
        page._domInteractive = pt._domInteractiveTime;
    }

    // Collection extensions. `_user_timing` is the legacy name canvas.js
    // scans for user-timing marks; chrome-har emits `_userTimings`.
    if (Array.isArray(pt._longTasks) && !Array.isArray(page._longTasks)) {
        page._longTasks = pt._longTasks;
    }
    if (pt._userTimings && page._user_timing == null) {
        page._user_timing = pt._userTimings;
    }
}

export async function processHARFileNode(input, options = {}) {

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
            const fd = fs.openSync(input, 'r');
            fs.readSync(fd, header, 0, 2, 0);
            fs.closeSync(fd);
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
                liftPageTimingsExtensions(value);
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

    } finally {
        if (reader) try { reader.releaseLock(); } catch {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }

    // Use statically imported buildWaterfallDataFromHar
    return buildWaterfallDataFromHar(output.log, 'har');
}
