/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { decodeHttp2 } from './http2-decoder.js';
import { decodeHttp1 } from './http1-decoder.js';

/**
 * ProtocolSniffer identifies the application layer protocol in use
 * based on the first few bytes of the Client -> Server stream.
 * It then delegates decoding to specifically tailored WPT semantic protocol decoders.
 */
export function decodeProtocol(conn) {
    if (!conn.clientFlow || conn.clientFlow.contiguousChunks.length === 0) {
        return; // No client data to sniff
    }

    // Inspect the very first client chunk
    const firstChunk = conn.clientFlow.contiguousChunks[0].bytes;
    const decoder = new TextDecoder('utf8');
    const dbgStr = decoder.decode(firstChunk.subarray(0, 24)).replace(/\r?\n|\r/g, ' ');

    if (globalThis.waterfallDebug) console.log(`[Sniffer] Checking connection... First bytes: ${dbgStr}... Length: ${firstChunk.length}`);

    // Minimum bytes needed to sniff HTTP/2 Magic (24 bytes)
    if (firstChunk.length >= 24) {
        // Decode magic bytes for sniffing
        const magicStr = decoder.decode(firstChunk.subarray(0, 24));
        if (magicStr === 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n') {
            if (globalThis.waterfallDebug) console.log("[Sniffer] Matched HTTP/2");
            conn.protocol = 'http2';
            conn.http2 = decodeHttp2(conn.clientFlow.contiguousChunks, conn.serverFlow.contiguousChunks);
            return;
        }
    }

    // Sniff for HTTP/1.x methods
    if (firstChunk.length >= 4) {
        const methodSniff = decoder.decode(firstChunk.subarray(0, 4));
        if (globalThis.waterfallDebug) console.log(`[Sniffer] Extracting 4 byte method: '${methodSniff}'`);
        if (methodSniff === 'GET ' || methodSniff === 'POST' || methodSniff === 'HEAD' || methodSniff === 'PUT ' || methodSniff === 'OPTI' || methodSniff === 'HTTP') {
            if (globalThis.waterfallDebug) console.log(`[Sniffer] Matched HTTP/1.1 using method ${methodSniff}`);
            conn.protocol = 'http/1.1';
            conn.http = decodeHttp1(conn.clientFlow.contiguousChunks, conn.serverFlow.contiguousChunks);
            return;
        }
    }
    
    conn.protocol = 'unknown';
}
