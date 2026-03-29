import { PcapParser } from './utilities/tcpdump/pcap-parser.js';
import { TcpReconstructor } from './utilities/tcpdump/tcp-reconstructor.js';
import { UdpReconstructor } from './utilities/tcpdump/udp-reconstructor.js';
import { decodeProtocol } from './utilities/tcpdump/protocol-sniffer.js';
import { decodeUdpProtocol } from './utilities/tcpdump/udp-sniffer.js';

export async function processTcpdumpNode(input, options = {}) {
    let stream = input;
    let isGz = options.isGz === true;
    let nodeFsStream = null;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import('node:fs');
            
            const header = Buffer.alloc(2);
            let fd;
            try {
                fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            
            isGz = header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
            
            const { Readable } = await import('node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

        if (isGz) {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const packets = [];
        const tcpReconstructor = new TcpReconstructor();
        const udpReconstructor = new UdpReconstructor();

        const parser = new PcapParser((packet) => {
            packets.push(packet);
            tcpReconstructor.push(packet);
            udpReconstructor.push(packet);
        });

        const reader = stream.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(value);
        }

        let keyLogContents = null;
        let keyLogInput = options.keyLogInput;
        if (!keyLogInput && typeof input === 'string') {
            keyLogInput = input.replace('.cap.gz', '.key_log.txt.gz');
            keyLogInput = keyLogInput.replace('.pcapng', '.key_log.txt');
            keyLogInput = keyLogInput.replace('.pcap', '.key_log.txt');
        }
        
        if (keyLogInput) {
            try {
                let klStream = keyLogInput;
                if (typeof keyLogInput === 'string') {
                    const fs = await import('node:fs');
                    const { Readable } = await import('node:stream');
                    klStream = Readable.toWeb(fs.createReadStream(keyLogInput));
                }
                
                let klIsGz = false;
                const peekReader = klStream.getReader();
                const { done, value } = await peekReader.read();
                
                if (!done && value) {
                    klIsGz = value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b;
                    
                    klStream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(value);
                        },
                        async pull(controller) {
                            const { done: innerDone, value: innerValue } = await peekReader.read();
                            if (innerDone) {
                                controller.close();
                            } else {
                                controller.enqueue(innerValue);
                            }
                        },
                        cancel(reason) {
                            peekReader.cancel(reason);
                        }
                    });
                } else {
                    klStream = new ReadableStream({
                        start(controller) { controller.close(); }
                    });
                }
                
                if (klIsGz) {
                    klStream = klStream.pipeThrough(new DecompressionStream('gzip'));
                }
                
                const decoder = new TextDecoderStream();
                const klPipeline = klStream.pipeThrough(decoder);
                const klReader = klPipeline.getReader();
                let klStr = '';
                while (true) {
                    const { done, value } = await klReader.read();
                    if (done) break;
                    klStr += value;
                }
                keyLogContents = klStr; 
                if (options.debug) console.log("KeyLog Length:", klStr.length);
            } catch (e) {
                if (options.debug || globalThis.waterfallDebug) console.error("KeyLog Stream Processing Error:", e);
                // It is completely valid for a keylog to not exist.
            }
        }

        let keyLogMap = null;
        if (keyLogContents) {
            const { TlsKeyLog } = await import('./utilities/tcpdump/tls-keylog.js');
            keyLogMap = new TlsKeyLog();
            keyLogMap.parseString(keyLogContents);
        }

        const tcpConnections = tcpReconstructor.getConnections();
        
        if (keyLogMap) {
            const { TlsDecoder } = await import('./utilities/tcpdump/tls-decoder.js');
            
            for (const conn of tcpConnections) {
                const decoder = new TlsDecoder(keyLogMap);
                
                const interleavedChunks = [];
                for (let chunk of conn.clientFlow.contiguousChunks) {
                    interleavedChunks.push({ dir: 0, chunk: chunk });
                }
                for (let chunk of conn.serverFlow.contiguousChunks) {
                    interleavedChunks.push({ dir: 1, chunk: chunk });
                }
                interleavedChunks.sort((a, b) => a.chunk.time - b.chunk.time);

                for (const item of interleavedChunks) {
                    await decoder.push(item.dir, item.chunk.bytes, item.chunk.time);
                }

                // If decryption succeeded (or produced anything), we replace the payload chunks
                const decClient = decoder.getDecryptedChunks(0);
                if (decClient.length > 0) {
                    conn.clientFlow.contiguousChunks = decClient;
                }
                
                const decServer = decoder.getDecryptedChunks(1);
                if (decServer.length > 0) {
                    conn.serverFlow.contiguousChunks = decServer;
                }
            }
        }
        
        const { DnsRegistry } = await import('./utilities/tcpdump/dns-registry.js');
        const { decodeTcpDns } = await import('./utilities/tcpdump/tcp-dns.js');
        const { extractDohRequests } = await import('./utilities/tcpdump/doh-decoder.js');
        
        let dnsRegistry = new DnsRegistry();

        // Decode protocols
        for (const conn of tcpConnections) {
            try {
                if (conn.serverPort === 53 || conn.clientPort === 53) {
                    decodeTcpDns(conn, dnsRegistry);
                } else {
                    decodeProtocol(conn);
                }
            } catch (e) {
                if (options.debug) console.error("Protocol Decoded Error:", e);
            }
        }
        
        // Identify DNS over HTTPS (DoH) mapped onto HTTP connections
        try {
            extractDohRequests(tcpConnections, dnsRegistry);
        } catch(e) {
            if (options.debug) console.error("DoH Extraction Error:", e);
        }
        
        const udpConnections = udpReconstructor.getConnections();
        if (options.debug) console.log(`[tcpdump.js] Start routing ${udpConnections.length} UDP connections`);
        let udpCount = 0;
        for (let i = 0; i < udpConnections.length; i++) {
            const conn = udpConnections[i];
            try {
                if (options.debug) console.log(`[tcpdump.js] Processing UDP ${i}/${udpConnections.length}...`);
                await decodeUdpProtocol(conn, keyLogMap, dnsRegistry, options);
                if (options.debug) console.log(`[tcpdump.js] Processed UDP ${i}.`);
                udpCount++;
            } catch (e) {
                 if (options.debug) console.error("UDP Decode Error:", e);
            }
        }
        if (options.debug) console.log(`[tcpdump.js] Successfully verified ${udpCount} UDP connections`);

        const harResult = generateHarFromTcpdump(tcpConnections, udpConnections, dnsRegistry.getLookups());
        return harResult;

    } catch (e) {
        console.error("Execution Error:", e);
        throw e;
    } finally {
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}

function generateHarFromTcpdump(tcpConnections, udpConnections, dnsLookups) {
    const entries = [];
    
    // Helper to resolve IP
    const resolveHostname = (ip) => {
        for (const lookup of dnsLookups) {
            if (lookup.ips && lookup.ips.includes(ip)) {
                return lookup.domain;
            }
        }
        return ip;
    };
    
    // Map connections helper
    const mapConnection = (conn, isUdp, getRequestsFunc) => {
        let reqs = getRequestsFunc(conn);
        if (!reqs) return;
        
        let connectTimeMs = -1;
        let connectEndTimeMs = -1;
        let sslStartTimeMs = -1;
        
        if (!isUdp) { // TCP connection timings
            // Connect: first SYN to SYN-ACK
            const syn = conn.clientFlow.allFrames.find(f => f.flags.SYN);
            const synAck = conn.serverFlow.allFrames.find(f => f.flags.SYN && f.flags.ACK);
            if (syn && synAck) {
                connectTimeMs = syn.time * 1000;
                connectEndTimeMs = synAck.time * 1000;
            }
            
            // TLS: Usually ClientHello (first data pkt from client). We approximate it here.
            // Our decoders might have exact timings but we can approximate TLS start as the first client payload
            const clientHello = conn.clientFlow.contiguousChunks.find(c => c.bytes.length > 5);
            if (clientHello) {
                sslStartTimeMs = clientHello.time * 1000;
            }
        }
        
        // Match UDP connection bindings
        if (isUdp && conn.quicParams && conn.quicParams.handshakeTime) {
            connectTimeMs = conn.clientFlow.frames[0].time * 1000;
            connectEndTimeMs = conn.quicParams.handshakeTime * 1000; // Handshake completed
            sslStartTimeMs = connectTimeMs; // QUIC folds TLS into 0-RTT/1-RTT
        }

        for (const req of reqs) {
            // Unify HTTP1, HTTP2, HTTP3 definitions into ExtendedHAREntry
            const timeMs = req.time * 1000; // Epoch ms
            
            // Find DNS
            let dnsTimeMs = -1;
            let dnsEndTimeMs = -1;
            let hostname = '';
            
            if (req.url) {
                try {
                    const parsed = new URL(req.url);
                    hostname = parsed.hostname;
                } catch(e) {}
            }
            
            if (hostname) {
                 const dnsRecord = dnsLookups.find(l => l.domain === hostname && (l.ips.includes(conn.serverIp) || l.cname)); // simplified match
                 if (dnsRecord) {
                      dnsTimeMs = dnsRecord.requestTime * 1000;
                      dnsEndTimeMs = dnsRecord.responseTime * 1000;
                 }
            }
            
            let firstDataTimeMs = -1;
            let lastDataTimeMs = -1;
            let bytesIn = 0;
            
            if (req._firstServerTimeMs !== undefined && req._firstServerTimeMs !== null) {
                 firstDataTimeMs = req._firstServerTimeMs * 1000;
                 lastDataTimeMs = (req._lastServerTimeMs !== null ? req._lastServerTimeMs : req._firstServerTimeMs) * 1000;
                 bytesIn = req.data ? req.data.reduce((acc, obj) => acc + (obj.length || 0), 0) : 0;
            } else if (req.data && req.data.length > 0) {
                 firstDataTimeMs = req.data[0].time * 1000;
                 lastDataTimeMs = req.data[req.data.length - 1].time * 1000;
                 bytesIn = req.data.reduce((acc, obj) => acc + (obj.length || 0), 0);
            }

            const reqMethod = req.method || 'GET';
            const reqUrl = req.url || `http://${conn.serverIp}/`;
            
            // Rebuild mapped arrays
            let harHeaders = [];
            if (Array.isArray(req.headers)) {
                harHeaders = req.headers;
            } else if (req.headers && typeof req.headers === 'object') {
                for (const [name, val] of Object.entries(req.headers)) {
                    harHeaders.push({name, value: val.toString()});
                }
            }
            
            let resHeaders = [];
            let contentType = "";
            if (req.responseHeaders) {
                if (Array.isArray(req.responseHeaders)) {
                    resHeaders = req.responseHeaders;
                } else if (typeof req.responseHeaders === 'object') {
                    for (const [name, val] of Object.entries(req.responseHeaders)) {
                        resHeaders.push({name, value: val.toString()});
                    }
                }
                const ctHeader = resHeaders.find(h => h.name.toLowerCase() === 'content-type');
                if (ctHeader) contentType = ctHeader.value.split(';')[0].trim();
            }
            
            // Standard Time mappings
            let send = 0; // Upload time
            let dns = (dnsTimeMs > 0 && dnsEndTimeMs > 0) ? Math.max(0, dnsEndTimeMs - dnsTimeMs) : -1;
            let connect = (connectTimeMs > 0 && connectEndTimeMs > 0) ? Math.max(0, connectEndTimeMs - connectTimeMs) : -1;
            let ssl = -1; 
            if (reqUrl.startsWith('https:') || isUdp) {
                if (isUdp) {
                    ssl = (sslStartTimeMs > 0 && connectEndTimeMs > 0) ? Math.max(0, connectEndTimeMs - sslStartTimeMs) : -1;
                } else {
                    ssl = (sslStartTimeMs > 0 && timeMs > 0) ? Math.max(0, timeMs - sslStartTimeMs) : -1;
                }
            }
            
            let totalTime = 0;
            if (lastDataTimeMs > 0) totalTime = Math.max(0, lastDataTimeMs - timeMs);
            
            let wait = (firstDataTimeMs > 0) ? Math.max(0, firstDataTimeMs - timeMs) : totalTime;
            let receive = (lastDataTimeMs > 0 && firstDataTimeMs > 0) ? Math.max(0, lastDataTimeMs - firstDataTimeMs) : 0;
            
            const reqObj = {
                startedDateTime: new Date(timeMs).toISOString(),
                time: totalTime,
                request: {
                    method: reqMethod,
                    url: reqUrl,
                    httpVersion: req.httpVersion || "HTTP/1.1",
                    cookies: [],
                    headers: harHeaders,
                    queryString: [],
                    headersSize: -1,
                    bodySize: -1
                },
                response: {
                    status: req.statusCode || 200,
                    statusText: req.statusText || "",
                    httpVersion: req.httpVersion || "HTTP/1.1",
                    cookies: [],
                    headers: resHeaders,
                    content: {
                        size: bytesIn,
                        mimeType: contentType,
                        compression: 0
                    },
                    redirectURL: "",
                    headersSize: -1,
                    bodySize: bytesIn
                },
                cache: {},
                timings: {
                    dns: dns,
                    connect: connect,
                    ssl: ssl,
                    send: send,
                    wait: wait,
                    receive: receive
                },
                serverIPAddress: conn.serverIp,
                connection: conn.id.toString(),
                _protocol: isUdp ? "QUIC" : "TCP",
                _bytesIn: bytesIn,
                _timeMs: timeMs,
                _dnsTimeMs: dnsTimeMs,
                _dnsEndTimeMs: dnsEndTimeMs,
                _connectTimeMs: connectTimeMs,
                _connectEndTimeMs: connectEndTimeMs,
                _sslStartTimeMs: sslStartTimeMs,
                _firstDataTimeMs: firstDataTimeMs,
                _lastDataTimeMs: lastDataTimeMs
            };
            entries.push(reqObj);
        }
    };
    
    // HTTP/1 Extractor
    const extractHttp1 = (conn) => {
        if (conn.protocol !== 'http/1.1' || !conn.http) return null;
        let reqs = [];
        for (let i = 0; i < conn.http.requests.length; i++) {
            let reqMsg = conn.http.requests[i];
            let resMsg = conn.http.responses[i] || {};
            
            // Handle reversed flows cleanly
            if (reqMsg.firstLine && reqMsg.firstLine.startsWith('HTTP/')) {
                 const tmp = reqMsg;
                 reqMsg = resMsg;
                 resMsg = tmp;
            }
            
            let method = "GET";
            let url = ""; 
            if (reqMsg.firstLine) {
                const parts = reqMsg.firstLine.split(' ');
                method = parts[0] || "GET";
                url = parts[1] || "";
            }
            
            let status = 200;
            let statusText = "OK";
            if (resMsg.firstLine) {
                const parts = resMsg.firstLine.split(' ');
                status = parseInt(parts[1]) || 200;
                statusText = parts.slice(2).join(' ');
            }
            
            let host = reqMsg.headers.find(h => h.name.toLowerCase() === 'host');
            let fullUrl = host ? `http://${host.value}${url}` : url;
            
            reqs.push({
                time: reqMsg.time,
                method: method,
                url: fullUrl,
                headers: reqMsg.headers,
                responseHeaders: resMsg.headers || [],
                statusCode: status,
                statusText: statusText,
                data: resMsg.data || [],
                httpVersion: "HTTP/1.1",
                _firstServerTimeMs: resMsg.time,
                _lastServerTimeMs: resMsg.data && resMsg.data.length > 0 ? resMsg.data[resMsg.data.length - 1].time : resMsg.time
            });
        }
        return reqs;
    };
    
    // HTTP/2 Extractor
    const extractHttp2 = (conn) => {
        let streams = conn.http2 ? conn.http2.streams : null;
        if (!streams) return null;
        
        let reqs = [];
        for (const [id, stream] of streams.entries()) {
            if (!stream.headers || !stream.headers.client || stream.headers.client.length === 0) continue;
            
            let method = stream.headers.client.find(h => h.name === ':method')?.value || 'GET';
            let path = stream.headers.client.find(h => h.name === ':path')?.value || '/';
            let auth = stream.headers.client.find(h => h.name === ':authority')?.value || resolveHostname(conn.serverIp);
            let scheme = stream.headers.client.find(h => h.name === ':scheme')?.value || 'https';
            let status = stream.headers.server ? (parseInt(stream.headers.server.find(h => h.name === ':status')?.value) || 200) : 200;
            
            let reqTime = stream.headers.clientTime || 0;
            
            reqs.push({
                time: reqTime,
                method: method,
                url: `${scheme}://${auth}${path}`,
                headers: stream.headers.client.filter(h => !h.name.startsWith(':')),
                responseHeaders: stream.headers.server ? stream.headers.server.filter(h => !h.name.startsWith(':')) : [],
                statusCode: status,
                data: stream.data.server || [],
                httpVersion: "HTTP/2",
                _firstServerTimeMs: stream.headers.serverTime || null,
                _lastServerTimeMs: stream.data.server && stream.data.server.length > 0 ? stream.data.server[stream.data.server.length - 1].time : (stream.headers.serverTime || null)
            });
        }
        return reqs;
    };

    // HTTP/3 Extractor
    const extractHttp3 = (conn) => {
        let streams = conn.http3;
        if (!streams) return null;
        
        let reqs = [];
        for (const [id, stream] of streams.entries()) {
            if ((!stream.headers || stream.headers.length === 0) && (!stream.responses || stream.responses.length === 0)) {
                console.log(`[tcpdump.js] Dropping incomplete stream ${id}`);
                continue; // Not a fully formed request stream
            }
            
            let method = stream.headers?.find(h => h.name === ':method')?.value || 'GET';
            let path = stream.headers?.find(h => h.name === ':path')?.value || '/';
            let auth = stream.headers?.find(h => h.name === ':authority')?.value || resolveHostname(conn.serverIp);
            let scheme = stream.headers?.find(h => h.name === ':scheme')?.value || 'https';
            let status = 200;
            
            let resHeaders = [];
            let dataBlocks = [];
            
            if (stream.responses) {
                 for (const res of stream.responses) {
                      if (res.headers && res.headers.length > 0) {
                           resHeaders = resHeaders.concat(res.headers);
                           status = parseInt(resHeaders.find(h => h.name === ':status')?.value) || status;
                      }
                      if (res.data) {
                           const byteLen = res.data.reduce((acc, b) => acc + (b.byteLength || b.length || 0), 0);
                           dataBlocks.push({ time: res.time || stream.time, length: byteLen, bytes: res.data });
                      }
                 }
            }
            
            let reqTime = stream.firstClientTime || stream.time;
            
            reqs.push({
                time: reqTime,
                method: method,
                url: `${scheme}://${auth}${path}`,
                headers: stream.headers.filter(h => !h.name.startsWith(':')),
                responseHeaders: resHeaders.filter(h => !h.name.startsWith(':')),
                statusCode: status,
                data: dataBlocks,
                httpVersion: "HTTP/3",
                _firstServerTimeMs: stream.firstServerTime,
                _lastServerTimeMs: stream.lastServerTime
            });
        }
        return reqs;
    };
    
    // Process TCP Connections
    for (const conn of tcpConnections) {
        if (conn.protocol === 'http/1.1') {
             mapConnection(conn, false, extractHttp1);
        } else if (conn.protocol === 'http2') {
             mapConnection(conn, false, extractHttp2);
        }
    }
    
    // Process UDP Connections
    for (const conn of udpConnections) {
        if (conn.http3 && conn.http3.size > 0) {
            mapConnection(conn, true, extractHttp3);
        }
    }
    
    // Chronological Sort
    entries.sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
    
    // Deduplicate DNS and Connection Timelines
    const seenDnsHosts = new Set();
    const seenConnections = new Set();
    
    // 0-Anchor Bounding Setup
    let globalEarliestMs = Number.MAX_SAFE_INTEGER;
    for (const entry of entries) {
        if (entry._timeMs > 0 && entry._timeMs < globalEarliestMs) globalEarliestMs = entry._timeMs;
        if (entry._dnsTimeMs > 0 && entry._dnsTimeMs < globalEarliestMs) globalEarliestMs = entry._dnsTimeMs;
        if (entry._connectTimeMs > 0 && entry._connectTimeMs < globalEarliestMs) globalEarliestMs = entry._connectTimeMs;
    }
    
    for (const entry of entries) {
        let hostname = '';
        try {
            hostname = new URL(entry.request.url).hostname;
        } catch(e) {}
        
        if (hostname && entry.timings.dns > -1) {
            if (seenDnsHosts.has(hostname)) {
                entry.timings.dns = -1;
                entry._dnsTimeMs = -1;
                entry._dnsEndTimeMs = -1;
            } else {
                seenDnsHosts.add(hostname);
            }
        }
        
        const connId = entry.connection;
        if (connId && (entry.timings.connect > -1 || entry.timings.ssl > -1)) {
            if (seenConnections.has(connId)) {
                entry.timings.connect = -1;
                entry.timings.ssl = -1;
                entry._connectTimeMs = -1;
                entry._connectEndTimeMs = -1;
                entry._sslStartTimeMs = -1;
            } else {
                seenConnections.add(connId);
            }
        }
        
        // Map native WebPageTest properties natively tracking off the exact globalEarliestMs anchor unconditionally
        if (entry._timeMs > 0) entry._load_start = Math.floor(entry._timeMs - globalEarliestMs);
        if (entry._dnsTimeMs > 0) entry._dns_start = Math.floor(entry._dnsTimeMs - globalEarliestMs);
        if (entry._dnsEndTimeMs > 0) entry._dns_end = Math.floor(entry._dnsEndTimeMs - globalEarliestMs);
        if (entry._connectTimeMs > 0) entry._connect_start = Math.floor(entry._connectTimeMs - globalEarliestMs);
        if (entry._connectEndTimeMs > 0) entry._connect_end = Math.floor(entry._connectEndTimeMs - globalEarliestMs);
        if (entry._sslStartTimeMs > 0) entry._ssl_start = Math.floor(entry._sslStartTimeMs - globalEarliestMs);
        if (entry._timeMs > 0 && entry.timings.ssl > 0) entry._ssl_end = entry._load_start;
        if (entry._timeMs > 0) entry._ttfb_start = entry._load_start;
        if (entry._firstDataTimeMs > 0) entry._ttfb_end = Math.floor(entry._firstDataTimeMs - globalEarliestMs);
        if (entry._firstDataTimeMs > 0) entry._download_start = entry._ttfb_end;
        if (entry._lastDataTimeMs > 0) {
            entry._download_end = Math.floor(entry._lastDataTimeMs - globalEarliestMs);
            entry._all_end = entry._download_end;
        }

        // Strict HAR 1.2 time enforcement directly summing non-negative active phases (avoids cross-idle stretching)
        let exactTime = 0;
        if (entry.timings.dns > 0) exactTime += entry.timings.dns;
        if (entry.timings.connect > 0) exactTime += entry.timings.connect;
        exactTime += entry.timings.wait;
        exactTime += entry.timings.receive;
        entry.time = exactTime;

        // Clean private tracking metrics implicitly
        delete entry._timeMs;
        delete entry._dnsTimeMs;
        delete entry._dnsEndTimeMs;
        delete entry._connectTimeMs;
        delete entry._connectEndTimeMs;
        delete entry._sslStartTimeMs;
        delete entry._firstDataTimeMs;
        delete entry._lastDataTimeMs;
    }
    
    // Assign proper references and Page Entry
    let pageStartedDateTime = (globalEarliestMs !== Number.MAX_SAFE_INTEGER) ? new Date(globalEarliestMs).toISOString() : new Date().toISOString();
    let pageId = 'page_0';
    let url = 'http://unknown/';
    
    if (entries.length > 0) {
        pageStartedDateTime = entries[0].startedDateTime;
        url = entries[0].request.url; // Default to first resource
        
        // Scan for explicit document base page via standard heuristics (sec-fetch-dest)
        for (const entry of entries) {
            const destHeader = entry.request.headers.find(h => h.name.toLowerCase() === 'sec-fetch-dest');
            if (destHeader && destHeader.value === 'document') {
                url = entry.request.url;
                pageStartedDateTime = entry.startedDateTime; // Override start if there was a disjoint stream prior (like DoH or pre-connect)
                break;
            }
            // Fallback heuristics: First 200 OK text/html
            const ctHeader = entry.response.headers.find(h => h.name.toLowerCase() === 'content-type');
            if (ctHeader && ctHeader.value.includes('text/html') && entry.response.status === 200) {
                url = entry.request.url;
                pageStartedDateTime = entry.startedDateTime;
                break;
            }
        }
    }
    
    // Bind all to pageref
    for (const entry of entries) {
        entry.pageref = pageId;
    }
    
    return {
        log: {
            version: "1.2",
            creator: {
                name: "waterfall-tools",
                version: "0.1.0"
            },
            pages: [
                {
                    startedDateTime: pageStartedDateTime,
                    id: pageId,
                    title: url,
                    pageTimings: {}
                }
            ],
            entries: entries
        }
    };
}
