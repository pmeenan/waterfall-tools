/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { PerfettoDecoder } from './utilities/perfetto/decoder.js';
import { processChromeTraceFileNode } from './chrome-trace.js';

/**
 * Standard processing wrapper bridging pure-JS Perfetto Protobuf streams 
 * into the legacy Chrome Trace JSON extended processing core naturally.
 */
export async function processPerfettoFileNode(input, options = {}) {
    let stream = input;
    let isGz = options.isGz === true;

    // Convert raw input files to a browser-safe Web Stream natively.
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

        isGz = header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
        
        const { Readable } = await import(/* @vite-ignore */ 'node:stream');
        const nodeFsStream = fs.createReadStream(input);
        stream = Readable.toWeb(nodeFsStream);
    }

    if (isGz) {
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }

    if (options.debug) console.log(`[perfetto.js] Initializing Perfetto Native Decoder pipeline.`);

    const decoder = new PerfettoDecoder({ debug: options.debug });
    
    // Pipe the uncompressed raw binary stream into our custom JSON transcoder
    const jsonStream = stream.pipeThrough(decoder.stream).pipeThrough(new TextEncoderStream());
    
    // Forward the translated virtual JSON Stream seamlessly to the existing chrome-trace processor
    // with trace events wrapper boolean explicitly declared so it doesn't try sniffing the virtual reader
    return processChromeTraceFileNode(jsonStream, {
        ...options,
        isGz: false,
        hasTraceEventsWrapper: true 
    });
}
