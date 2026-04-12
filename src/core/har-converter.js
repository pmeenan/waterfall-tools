/**
 * Sniff the MIME type from response body content when the Content-Type header is missing.
 * Examines the first bytes of the decoded body to detect HTML, JavaScript, CSS,
 * common image formats (JPEG, PNG, GIF, WebP, AVIF, HEIC), and fonts (WOFF, WOFF2, TTF, OTF).
 * @param {string} bodyText - The body text (may be base64-encoded)
 * @param {string} [encoding] - 'base64' if the body is base64-encoded
 * @returns {string} Detected MIME type, or empty string if unrecognized
 */
export function sniffMimeType(bodyText, encoding) {
    if (!bodyText || typeof bodyText !== 'string') return '';

    let sample;
    if (encoding === 'base64') {
        // Decode a small portion — 1024 base64 chars yields ~768 decoded bytes
        try {
            sample = atob(bodyText.substring(0, 1024));
        } catch (e) {
            return '';
        }
    } else {
        sample = bodyText.substring(0, 1024);
    }

    // --- Binary format detection via magic bytes (checked before text trimming) ---
    // atob returns a binary string where charCodeAt maps directly to byte values
    if (sample.length >= 4) {
        const b0 = sample.charCodeAt(0);
        const b1 = sample.charCodeAt(1);
        const b2 = sample.charCodeAt(2);

        // JPEG: FF D8 FF
        if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return 'image/jpeg';

        // PNG: 89 50 4E 47 (\x89PNG)
        if (b0 === 0x89 && sample.substring(1, 4) === 'PNG') return 'image/png';

        // GIF87a / GIF89a
        if (sample.substring(0, 4) === 'GIF8') return 'image/gif';

        // WebP: RIFF at 0-3, WEBP at 8-11
        if (sample.length >= 12 && sample.substring(0, 4) === 'RIFF' && sample.substring(8, 12) === 'WEBP') return 'image/webp';

        // ISOBMFF containers (AVIF / HEIC): ftyp box marker at offset 4, brand at offset 8
        if (sample.length >= 12 && sample.substring(4, 8) === 'ftyp') {
            const brand = sample.substring(8, 12);
            if (brand === 'avif' || brand === 'avis') return 'image/avif';
            if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1') return 'image/heic';
        }

        // WOFF: wOFF
        if (sample.substring(0, 4) === 'wOFF') return 'font/woff';
        // WOFF2: wOF2
        if (sample.substring(0, 4) === 'wOF2') return 'font/woff2';
        // TrueType: 00 01 00 00
        if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && sample.charCodeAt(3) === 0x00) return 'font/ttf';
        // OpenType/CFF: OTTO
        if (sample.substring(0, 4) === 'OTTO') return 'font/otf';
    }

    // Trim leading whitespace and BOM for text-based pattern matching
    const trimmed = sample.replace(/^[\s\uFEFF\xEF\xBB\xBF]+/, '');
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();

    // --- HTML detection ---
    if (lower.startsWith('<!doctype') ||
        lower.startsWith('<html') ||
        lower.startsWith('<head') ||
        lower.startsWith('<body')) {
        return 'text/html';
    }
    // HTML comment followed by document structure
    if (lower.startsWith('<!--') &&
        (lower.includes('<html') || lower.includes('<head') || lower.includes('<!doctype'))) {
        return 'text/html';
    }

    // --- CSS detection (check before JS since @import could appear in both) ---
    if (lower.startsWith('@charset') || lower.startsWith('@import') ||
        lower.startsWith('@media') || lower.startsWith('@font-face') ||
        lower.startsWith('@keyframes') || lower.startsWith('@layer') ||
        lower.startsWith('@supports') || lower.startsWith('@namespace')) {
        return 'text/css';
    }
    // CSS selector patterns followed by property declarations — e.g. "body { margin: 0 }"
    if (/^[a-z*#.:\[_][^{]*\{[^}]*[;:]/i.test(trimmed)) {
        if (/\b(display|margin|padding|color|background|font-|border|width|height|position|overflow|text-align|flex|grid)\s*:/i.test(trimmed)) {
            return 'text/css';
        }
    }

    // --- JavaScript detection ---
    // Common leading tokens in JS files
    if (lower.startsWith('(function') || lower.startsWith('function ') || lower.startsWith('function(') ||
        lower.startsWith('var ') || lower.startsWith('let ') || lower.startsWith('const ') ||
        lower.startsWith('"use strict"') || lower.startsWith("'use strict'") ||
        lower.startsWith('import ') || lower.startsWith('export ') ||
        lower.startsWith('window.') || lower.startsWith('document.') ||
        lower.startsWith('self.') || lower.startsWith('globalthis.')) {
        return 'application/javascript';
    }
    // Minified JS patterns: !function(...), (()=>{, (() => {
    if (trimmed.startsWith('!function') || /^\(\s*\(\s*\)/.test(trimmed) ||
        /^\(\s*function\s*\(/.test(trimmed) || trimmed.startsWith('void function')) {
        return 'application/javascript';
    }
    // JS with leading single-line or block comment
    if ((lower.startsWith('//') || lower.startsWith('/*')) &&
        /\b(function[ (]|var |let |const |import |export |return[ ;]|=>)\b/.test(sample)) {
        return 'application/javascript';
    }

    return '';
}

export function buildWaterfallDataFromHar(harLog, format = 'har') {
    const data = {
        metadata: { format },
        pages: {},
        tcp_connections: {},
        http2_connections: {},
        quic_connections: {},
        dns: {}
    };

    let globalEarliestMs = Number.MAX_SAFE_INTEGER;

    if (harLog._id) data._id = harLog._id;
    if (harLog._zipFiles) data._zipFiles = harLog._zipFiles;

    // Build pages
    if (harLog.pages && Array.isArray(harLog.pages)) {
        for (const p of harLog.pages) {
            data.pages[p.id] = {
                url: p.title || '',
                title: p.title || '',
                startedDateTime: p.startedDateTime || new Date().toISOString(),
                pageTimings: p.pageTimings || {},
                requests: {},
                // Carry over WPT custom page timings naturally
                _render: p._render || -1,
                _domContentLoadedEventStart: p._domContentLoadedEventStart || -1,
                _domContentLoadedEventEnd: p._domContentLoadedEventEnd || -1,
                _loadEventStart: p._loadEventStart || -1,
                _loadEventEnd: p._loadEventEnd || -1,
                _firstContentfulPaint: p._firstContentfulPaint || -1,
                _LargestContentfulPaint: p._LargestContentfulPaint || -1,
                _domInteractive: p._domInteractive || -1,
                _bwDown: p._bwDown || -1
            };
            
            // Map any other custom properties natively (like _unlinked_connections, _almanac, etc)
            for (const key of Object.keys(p)) {
                if (key.startsWith('_') && data.pages[p.id][key] === undefined) {
                    data.pages[p.id][key] = p[key];
                    if (key === '_testId' && !data._id) data._id = p[key];
                }
            }
        }
    }
    
    // Default page if none exist
    if (Object.keys(data.pages).length === 0) {
        data.pages["page_0"] = {
            url: "", title: "", startedDateTime: new Date().toISOString(), pageTimings: {}, requests: {}
        };
    }

    let reqIndex = 0;
    
    // Map connections and DNS from entries
    if (harLog.entries && Array.isArray(harLog.entries)) {
        for (const entry of harLog.entries) {
            const reqId = `req_${reqIndex++}`;
            const pageId = entry.pageref || (Object.keys(data.pages).length > 0 ? Object.keys(data.pages)[0] : "page_0");
            
            if (!data.pages[pageId]) {
                data.pages[pageId] = { url: "", title: "", startedDateTime: entry.startedDateTime, pageTimings: {}, requests: {} };
            }

            const timeMs = new Date(entry.startedDateTime).getTime();
            if (timeMs > 0 && timeMs < globalEarliestMs) globalEarliestMs = timeMs;
            
            // Infer DNS
            let dnsId = null;
            if (entry.timings && entry.timings.dns > 0) {
                dnsId = `dns_${reqId}`;
                const domain = (entry.request && entry.request.url) ? new URL(entry.request.url).hostname : '';
                data.dns[dnsId] = {
                    query: domain,
                    type: "A",
                    ip_addresses: [entry.serverIPAddress].filter(Boolean),
                    start_time: timeMs,
                    end_time: timeMs + entry.timings.dns
                };
            } else if (entry._dnsTimeMs > 0 && entry._dnsEndTimeMs > 0) {
                dnsId = `dns_${reqId}`;
                const domain = (entry.request && entry.request.url) ? new URL(entry.request.url).hostname : '';
                data.dns[dnsId] = {
                    query: domain, type: "A", ip_addresses: [entry.serverIPAddress].filter(Boolean),
                    start_time: entry._dnsTimeMs, end_time: entry._dnsEndTimeMs
                };
                if (entry._dnsTimeMs < globalEarliestMs) globalEarliestMs = entry._dnsTimeMs;
            }
            
            // Infer Connection
            let connId = entry.connection ? entry.connection.toString() : null;
            if (!connId && entry._socket !== undefined && entry._socket !== -1 && entry._socket !== "-1") connId = entry._socket.toString();
            if (!connId && entry._connectionId !== undefined && entry._connectionId !== -1 && entry._connectionId !== "-1") connId = entry._connectionId.toString();
            if (!connId && entry._connectionIdentifier !== undefined && entry._connectionIdentifier !== -1 && entry._connectionIdentifier !== "-1") connId = entry._connectionIdentifier.toString();
            
            if (entry.timings && entry.timings.connect > 0 || (entry._connectTimeMs > 0 && entry._connectEndTimeMs > 0)) {
                if (!connId) connId = `conn_${reqId}`;
                
                let connectStart = entry._connectTimeMs > 0 ? entry._connectTimeMs : timeMs + Math.max(0, entry.timings.dns);
                let connectEnd = entry._connectEndTimeMs > 0 ? entry._connectEndTimeMs : connectStart + entry.timings.connect;
                
                let sslStart = null;
                if (entry._sslStartTimeMs > 0) sslStart = entry._sslStartTimeMs;
                else if (entry.timings.ssl > 0) sslStart = connectEnd - entry.timings.ssl;

                if (connectStart > 0 && connectStart < globalEarliestMs) globalEarliestMs = connectStart;

                let isUdp = entry._protocol === 'QUIC' || entry._protocol === 'HTTP/3';

                let serverPort = 80;
                try {
                    const parsedUrl = new URL(entry.request.url);
                    serverPort = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
                } catch(e) {}

                if (!isUdp && !data.tcp_connections[connId]) {
                    data.tcp_connections[connId] = {
                        ip: entry.serverIPAddress,
                        port: serverPort,
                        client_port: 0,
                        start_time: connectStart,
                        end_time: connectEnd,
                        bytes_sent: 0,
                        bytes_received: 0,
                        tls: sslStart > 0 ? { start_time: sslStart } : null
                    };
                } else if (isUdp && !data.quic_connections[connId]) {
                    data.quic_connections[connId] = {
                        ip: entry.serverIPAddress,
                        port: serverPort,
                        client_port: 0,
                        start_time: connectStart,
                        end_time: connectEnd,
                        tls: sslStart > 0 ? { start_time: sslStart } : null
                    };
                }
            }
            
            let firstDataTimeMs = entry._firstDataTimeMs > 0 ? entry._firstDataTimeMs : (timeMs + Math.max(0, entry.timings.blocked || 0) + Math.max(0, entry.timings.dns || 0) + Math.max(0, entry.timings.connect || 0) + Math.max(0, entry.timings.send || 0) + Math.max(0, entry.timings.wait || 0));
            let lastDataTimeMs = entry._lastDataTimeMs > 0 ? entry._lastDataTimeMs : firstDataTimeMs + Math.max(0, entry.timings.receive || 0);

            let bytesIn = entry._bytesIn !== undefined ? entry._bytesIn : (entry.response && entry.response.content ? entry.response.content.size : 0);
            
            data.pages[pageId].requests[reqId] = {
                url: entry.request ? entry.request.url : '',
                method: entry.request ? entry.request.method : 'GET',
                status: entry.response ? entry.response.status : 200,
                statusText: entry.response ? entry.response.statusText : '',
                httpVersion: entry.request ? entry.request.httpVersion : 'HTTP/1.1',
                headers: entry.request ? entry.request.headers : [],
                responseHeaders: entry.response ? entry.response.headers : [],
                mimeType: (entry.response && entry.response.content) ? entry.response.content.mimeType : '',
                bytes_in: bytesIn,
                serverIp: entry.serverIPAddress,
                time_start: timeMs,
                first_data_time: firstDataTimeMs,
                time_end: lastDataTimeMs,
                connection_id: connId,
                dns_query_id: dnsId,
                stream_id: null,
                _chunks: entry._chunks || []
            };
            
            // Transfer response body content if present (e.g., from netlog decoded bytes or standard HAR)
            if (entry.response && entry.response.content && entry.response.content.text !== undefined) {
                data.pages[pageId].requests[reqId].body = entry.response.content.text;
                if (entry.response.content.encoding) {
                    data.pages[pageId].requests[reqId].bodyEncoding = entry.response.content.encoding;
                }
            }

            // Sniff MIME type from body content when Content-Type header is missing.
            // This ensures correct waterfall coloring and viewer body display for
            // requests where headers were unavailable (e.g. partially-decoded QUIC/TLS flows).
            const req = data.pages[pageId].requests[reqId];
            if (!req.mimeType && req.body) {
                const sniffed = sniffMimeType(req.body, req.bodyEncoding);
                if (sniffed) {
                    req.mimeType = sniffed;
                }
            }

            // Map ALL custom HAR properties inherently preventing data loss across ingestion streams
            for (const key of Object.keys(entry)) {
                if (key.startsWith('_') && data.pages[pageId].requests[reqId][key] === undefined) {
                    data.pages[pageId].requests[reqId][key] = entry[key];
                }
            }
        }
    }

    if (globalEarliestMs !== Number.MAX_SAFE_INTEGER && data.pages["page_0"] && !data.pages["page_0"].startedDateTime) {
        data.pages["page_0"].startedDateTime = new Date(globalEarliestMs).toISOString();
    }

    return data;
}
