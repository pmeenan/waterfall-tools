/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { decodeDns } from './dns-decoder.js';

export function extractDohRequests(tcpConnections, dnsRegistry) {
    for (const conn of tcpConnections) {
        if (conn.protocol === 'http/1.1' && conn.http) {
            processHttp1(conn.http, dnsRegistry);
        } else if (conn.protocol === 'http2' && conn.http2) {
            processHttp2(conn.http2, dnsRegistry);
        }
    }
}

const concatUint8Arrays = (arrays) => {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const res = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        res.set(arr, offset);
        offset += arr.length;
    }
    return res;
};

function decodeBase64Url(base64UrlStr) {
    let base64 = base64UrlStr.replace(/-/g, '+').replace(/_/, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    const binString = globalThis.atob(base64);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
        bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
}

function processHttp1(httpData, dnsRegistry) {
    for (const req of httpData.requests) {
        // Find matching response structurally by order (HTTP/1.1 pipeline)
        const res = httpData.responses[httpData.requests.indexOf(req)];
        let isValidContentType = false;
        if (res && res.headers) {
            const ct = res.headers.find(h => h.name.toLowerCase() === 'content-type');
            if (ct && ct.value.includes('application/dns-message')) {
                isValidContentType = true;
            }
        }
        
        let dnsQueryPayload = null;
        
        // Is it a GET request with ?dns=
        if (req.firstLine.includes('?dns=')) {
            const urlPart = req.firstLine.split(' ')[1];
            const dnsMatch = urlPart.match(/\?dns=([^&]+)/);
            if (dnsMatch && dnsMatch[1]) {
                try {
                    dnsQueryPayload = decodeBase64Url(dnsMatch[1]);
                } catch(e) { /* malformed base64 ignore */ }
            }
        } else if (req.firstLine.startsWith('POST ') && req.headers) {
            const reqCt = req.headers.find(h => h.name.toLowerCase() === 'content-type');
            if (reqCt && reqCt.value.includes('application/dns-message')) {
                dnsQueryPayload = concatUint8Arrays(req.data.map(d => d.bytes));
            }
        }
        
        if (dnsQueryPayload || isValidContentType) {
            let answers = [];
            let queries = [];
            
            if (dnsQueryPayload) {
                const parsedReq = decodeDns(dnsQueryPayload);
                if (parsedReq) queries = parsedReq.queries;
            }
            
            if (res && isValidContentType && res.data && res.data.length > 0) {
                const resBuf = concatUint8Arrays(res.data.map(d => d.bytes));
                const parsedRes = decodeDns(resBuf);
                if (parsedRes) answers = parsedRes.answers;
            }

            // Extract explicit timings based on start of request / start of response frames
            const reqTime = req.data.length > 0 ? req.data[0].time : req.time || 0;
            const resTime = res && res.data.length > 0 ? res.data[0].time : (res ? res.time || reqTime : reqTime);
            
            const domain = queries.length > 0 ? queries[0].name : 'unknown';
            const ips = answers.map(a => a.address).filter(Boolean);
            
            // Only add if we actually decoded relevant IP mappings successfully
            if (queries.length > 0) {
                dnsRegistry.addCompletedLookup(domain, ips, reqTime, resTime, 'DoH (HTTP/1.1)');
            }
        }
    }
}

function processHttp2(http2Data, dnsRegistry) {
    for (const [streamId, stream] of http2Data.streams.entries()) {
        const clientHeaders = stream.headers.client || [];
        const serverHeaders = stream.headers.server || [];
        
        const method = clientHeaders.find(h => h.name === ':method')?.value;
        const path = clientHeaders.find(h => h.name === ':path')?.value;
        const reqCt = clientHeaders.find(h => h.name === 'content-type')?.value;
        const resCt = serverHeaders.find(h => h.name === 'content-type')?.value;
        
        let dnsQueryPayload = null;
        
        if (method === 'GET' && path && path.includes('?dns=')) {
            const dnsMatch = path.match(/\?dns=([^&]+)/);
            if (dnsMatch && dnsMatch[1]) {
                try {
                    dnsQueryPayload = decodeBase64Url(dnsMatch[1]);
                } catch(e) {}
            }
        } else if (method === 'POST' && reqCt && reqCt.includes('application/dns-message')) {
            dnsQueryPayload = concatUint8Arrays(stream.data.client.map(c => c.bytes));
        }
        
        const isResDns = resCt && resCt.includes('application/dns-message');
        
        // If HTTP/2 context mirrors DNS request/responses
        if (dnsQueryPayload || isResDns) {
            let answers = [];
            let queries = [];
            
            if (dnsQueryPayload) {
                const parsedReq = decodeDns(dnsQueryPayload);
                if (parsedReq) queries = parsedReq.queries;
            }
            
            if (isResDns && stream.data.server && stream.data.server.length > 0) {
                const resBuf = concatUint8Arrays(stream.data.server.map(s => s.bytes));
                const parsedRes = decodeDns(resBuf);
                if (parsedRes) answers = parsedRes.answers;
            }
            
            const reqTime = stream.data.client.length > 0 ? stream.data.client[0].time : 0;
            const resTime = stream.data.server.length > 0 ? stream.data.server[0].time : reqTime;
            
            const domain = queries.length > 0 ? queries[0].name : 'unknown';
            const ips = answers.map(a => a.address).filter(Boolean);
            
            if (queries.length > 0) {
                dnsRegistry.addCompletedLookup(domain, ips, reqTime, resTime, 'DoH (HTTP/2)');
            }
        }
    }
}
