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
