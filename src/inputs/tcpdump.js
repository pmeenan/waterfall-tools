import { PcapParser } from './utilities/tcpdump/pcap-parser.js';
import { TcpReconstructor } from './utilities/tcpdump/tcp-reconstructor.js';
import { UdpReconstructor } from './utilities/tcpdump/udp-reconstructor.js';
import { decodeProtocol } from './utilities/tcpdump/protocol-sniffer.js';
import { decodeUdpProtocol } from './utilities/tcpdump/udp-sniffer.js';

export async function processTcpdumpNode(input, options = {}) {
    let stream = input;
    let isGz = options.isGz === true;
    let nodeFsStream = null;
    let reader = null;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');
            
            const header = new Uint8Array(2);
            let fd;
            try {
                fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            
            isGz = header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
            
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
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

        reader = stream.getReader();
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
                    const fs = await import(/* @vite-ignore */ 'node:fs');
                    const { Readable } = await import(/* @vite-ignore */ 'node:stream');
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

        const dataResult = await buildWaterfallDataFromTcpdump(tcpConnections, udpConnections, dnsRegistry.getLookups());
        return dataResult;

    } catch (e) {
        console.error("Execution Error:", e);
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}

/**
 * Concatenates body data chunks from HTTP decoders into a single Uint8Array.
 * Handles both HTTP/1 & HTTP/2 chunks ({bytes: Uint8Array}) and HTTP/3 blocks
 * ({bytes: Uint8Array[]}) transparently.
 */
function concatenateBodyChunks(dataChunks) {
    let totalLen = 0;
    for (const chunk of dataChunks) {
        if (Array.isArray(chunk.bytes)) {
            for (const b of chunk.bytes) totalLen += b.byteLength || b.length || 0;
        } else if (chunk.bytes) {
            totalLen += chunk.bytes.byteLength || chunk.bytes.length || 0;
        }
    }
    if (totalLen === 0) return null;

    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of dataChunks) {
        if (Array.isArray(chunk.bytes)) {
            for (const b of chunk.bytes) {
                combined.set(b, offset);
                offset += b.byteLength || b.length || 0;
            }
        } else if (chunk.bytes) {
            combined.set(chunk.bytes, offset);
            offset += chunk.bytes.byteLength || chunk.bytes.length || 0;
        }
    }
    return combined;
}

/**
 * Extracts response body bytes from parsed data chunks, decompresses if the
 * response uses gzip/deflate content-encoding, base64-encodes the result,
 * and stores it on the request entry as body + bodyEncoding.
 */
async function extractAndStoreBody(dataChunks, responseHeaders, reqEntry) {
    try {
        const combined = concatenateBodyChunks(dataChunks);
        if (!combined) return;

        let bodyBytes = combined;

        // Decompress if content-encoding header is present
        const ceHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-encoding');
        if (ceHeader) {
            const encoding = ceHeader.value.toLowerCase().trim();
            // DecompressionStream supports 'gzip', 'deflate', and 'deflate-raw' in
            // evergreen browsers and Node 18+. Brotli ('br') is not universally
            // supported so we skip decompression for it and store raw bytes.
            let algo = null;
            if (encoding === 'gzip') algo = 'gzip';
            else if (encoding === 'deflate') algo = 'deflate';
            if (algo) {
                try {
                    const ds = new DecompressionStream(algo);
                    const writer = ds.writable.getWriter();
                    const reader = ds.readable.getReader();
                    // Catch writer-side errors to prevent unhandled rejections when
                    // the underlying data is truncated or not actually compressed
                    const writePromise = writer.write(combined)
                        .then(() => writer.close())
                        .catch(() => {});

                    const parts = [];
                    let totalDecompressed = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        parts.push(value);
                        totalDecompressed += value.length;
                    }
                    await writePromise;

                    bodyBytes = new Uint8Array(totalDecompressed);
                    let off = 0;
                    for (const part of parts) {
                        bodyBytes.set(part, off);
                        off += part.length;
                    }
                } catch (_) {
                    // Decompression failed — store raw wire bytes as fallback
                }
            }
        }

        // Convert Uint8Array to base64 using chunked String.fromCharCode
        // to avoid call-stack limits on large bodies
        let binary = '';
        for (let i = 0; i < bodyBytes.length; i++) {
            binary += String.fromCharCode(bodyBytes[i]);
        }
        reqEntry.body = btoa(binary);
        reqEntry.bodyEncoding = 'base64';
    } catch (_) {
        // Body extraction failed — skip silently rather than breaking the request
    }
}

async function buildWaterfallDataFromTcpdump(tcpConnections, udpConnections, dnsLookups) {
    const data = {
        metadata: { format: 'tcpdump' },
        pages: {
            "page_0": {
                id: "page_0",
                url: "http://unknown/",
                title: "",
                startedDateTime: new Date().toISOString(),
                pageTimings: {},
                requests: {}
            }
        },
        tcp_connections: {},
        http2_connections: {},
        quic_connections: {},
        dns: {}
    };

    let reqIndex = 0;
    // Async body extraction tasks — processed in parallel after all connections are mapped
    const bodyTasks = [];

    // Process DNS
    for (let i = 0; i < dnsLookups.length; i++) {
        const lookup = dnsLookups[i];
        const dnsId = `dns_${i}`;
        data.dns[dnsId] = {
            query: lookup.domain,
            type: lookup.type || "A",
            ip_addresses: lookup.ips || [],
            start_time: lookup.requestTime * 1000,
            end_time: lookup.responseTime * 1000
        };
        lookup._dsnId = dnsId;
    }

    const resolveHostname = (ip) => {
        for (const lookup of dnsLookups) {
            if (lookup.ips && lookup.ips.includes(ip)) return lookup.domain;
        }
        return ip;
    };

    const mapConnection = (conn, isUdp, getRequestsFunc) => {
        let reqs = getRequestsFunc(conn);
        
        let connectTimeMs = -1;
        let connectEndTimeMs = -1;
        let sslStartTimeMs = -1;
        
        if (!isUdp) {
            const syn = conn.clientFlow.allFrames.find(f => f.flags.SYN);
            const synAck = conn.serverFlow.allFrames.find(f => f.flags.SYN && f.flags.ACK);
            if (syn && synAck) {
                connectTimeMs = syn.time * 1000;
                connectEndTimeMs = synAck.time * 1000;
            }
            const clientHello = conn.clientFlow.contiguousChunks.find(c => c.bytes.length > 5);
            if (clientHello) sslStartTimeMs = clientHello.time * 1000;
            
            data.tcp_connections[conn.id.toString()] = {
                ip: conn.serverIp,
                port: conn.serverPort,
                client_port: conn.clientPort,
                start_time: connectTimeMs > 0 ? connectTimeMs : null,
                end_time: connectEndTimeMs > 0 ? connectEndTimeMs : null,
                bytes_sent: conn.clientFlow.bytesSent || 0,
                bytes_received: conn.serverFlow.bytesReceived || 0,
                tls: { start_time: sslStartTimeMs > 0 ? sslStartTimeMs : null }
            };
        } else {
            if (conn.quicParams && conn.quicParams.handshakeTime) {
                connectTimeMs = conn.clientFlow.frames[0].time * 1000;
                connectEndTimeMs = conn.quicParams.handshakeTime * 1000;
                sslStartTimeMs = connectTimeMs;
            }
            data.quic_connections[conn.id.toString()] = {
                ip: conn.serverIp,
                port: conn.serverPort,
                client_port: conn.clientPort,
                start_time: connectTimeMs > 0 ? connectTimeMs : null,
                end_time: connectEndTimeMs > 0 ? connectEndTimeMs : null,
                tls: { start_time: sslStartTimeMs > 0 ? sslStartTimeMs : null }
            };
        }
        
        if (!reqs) return;

        for (const req of reqs) {
            const timeMs = req.time * 1000;
            
            let hostname = '';
            if (req.url) {
                try { hostname = new URL(req.url).hostname; } catch(e) {}
            }
            
            let dnsId = null;
            if (hostname) {
                 const dnsRecord = dnsLookups.find(l => l.domain === hostname && (l.ips.includes(conn.serverIp) || l.cname));
                 if (dnsRecord && dnsRecord._dsnId) dnsId = dnsRecord._dsnId;
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

            let harHeaders = [];
            if (Array.isArray(req.headers)) harHeaders = req.headers;
            else if (req.headers && typeof req.headers === 'object') {
                for (const [name, val] of Object.entries(req.headers)) harHeaders.push({name, value: val.toString()});
            }
            
            let resHeaders = [];
            let contentType = "";
            let resStatus = req.statusCode || 200;
            if (req.responseHeaders) {
                if (Array.isArray(req.responseHeaders)) resHeaders = req.responseHeaders;
                else if (typeof req.responseHeaders === 'object') {
                    for (const [name, val] of Object.entries(req.responseHeaders)) resHeaders.push({name, value: val.toString()});
                }
                const ctHeader = resHeaders.find(h => h.name.toLowerCase() === 'content-type');
                if (ctHeader) contentType = ctHeader.value.split(';')[0].trim();
                const statusHeader = resHeaders.find(h => h.name.toLowerCase() === ':status');
                if(statusHeader) resStatus = parseInt(statusHeader.value) || resStatus;
            }

            const reqId = `req_${reqIndex++}`;
            const reqEntry = {
                url: req.url || `http://${conn.serverIp}/`,
                method: req.method || 'GET',
                status: resStatus,
                statusText: req.statusText || "",
                httpVersion: req.httpVersion || "HTTP/1.1",
                headers: harHeaders,
                responseHeaders: resHeaders,
                mimeType: contentType,
                bytes_in: bytesIn,
                serverIp: conn.serverIp,
                time_start: timeMs,
                first_data_time: firstDataTimeMs,
                time_end: lastDataTimeMs,
                connection_id: conn.id.toString(),
                dns_query_id: dnsId,
                stream_id: req.streamId || null,
                _protocol: isUdp ? "QUIC" : "TCP"
            };
            data.pages["page_0"].requests[reqId] = reqEntry;

            // Schedule async body extraction (decompression + base64 encoding)
            if (req.data && req.data.length > 0) {
                bodyTasks.push(extractAndStoreBody(req.data, resHeaders, reqEntry));
            }
        }
    };

    const extractHttp1 = (conn) => {
        if (conn.protocol !== 'http/1.1' || !conn.http) return null;
        let reqs = [];
        for (let i = 0; i < conn.http.requests.length; i++) {
            let reqMsg = conn.http.requests[i];
            let resMsg = conn.http.responses[i] || {};
            if (reqMsg.firstLine && reqMsg.firstLine.startsWith('HTTP/')) {
                 const tmp = reqMsg; reqMsg = resMsg; resMsg = tmp;
            }
            let method = "GET"; let url = ""; 
            if (reqMsg.firstLine) {
                const parts = reqMsg.firstLine.split(' ');
                method = parts[0] || "GET"; url = parts[1] || "";
            }
            let status = 200; let statusText = "OK";
            if (resMsg.firstLine) {
                const parts = resMsg.firstLine.split(' ');
                status = parseInt(parts[1]) || 200;
                statusText = parts.slice(2).join(' ');
            }
            let host = reqMsg.headers.find(h => h.name.toLowerCase() === 'host');
            let fullUrl = host ? `http://${host.value}${url}` : url;
            reqs.push({
                time: reqMsg.time, method: method, url: fullUrl,
                headers: reqMsg.headers, responseHeaders: resMsg.headers || [],
                statusCode: status, statusText: statusText, data: resMsg.data || [],
                httpVersion: "HTTP/1.1",
                _firstServerTimeMs: resMsg.time,
                _lastServerTimeMs: resMsg.data && resMsg.data.length > 0 ? resMsg.data[resMsg.data.length - 1].time : resMsg.time
            });
        }
        return reqs;
    };
    
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
                time: reqTime, method: method, url: `${scheme}://${auth}${path}`,
                headers: stream.headers.client.filter(h => !h.name.startsWith(':')),
                responseHeaders: stream.headers.server ? stream.headers.server.filter(h => !h.name.startsWith(':')) : [],
                statusCode: status, data: stream.data.server || [],
                httpVersion: "HTTP/2", streamId: id,
                _firstServerTimeMs: stream.headers.serverTime || null,
                _lastServerTimeMs: stream.data.server && stream.data.server.length > 0 ? stream.data.server[stream.data.server.length - 1].time : (stream.headers.serverTime || null)
            });
        }
        return reqs;
    };

    const extractHttp3 = (conn) => {
        let streams = conn.http3;
        if (!streams) return null;
        let reqs = [];
        for (const [id, stream] of streams.entries()) {
            if ((!stream.headers || stream.headers.length === 0) && (!stream.responses || stream.responses.length === 0)) continue;
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
                time: reqTime, method: method, url: `${scheme}://${auth}${path}`,
                headers: stream.headers ? stream.headers.filter(h => !h.name.startsWith(':')) : [],
                responseHeaders: resHeaders.filter(h => !h.name.startsWith(':')),
                statusCode: status, data: dataBlocks, streamId: id,
                httpVersion: "HTTP/3",
                _firstServerTimeMs: stream.firstServerTime,
                _lastServerTimeMs: stream.lastServerTime
            });
        }
        return reqs;
    };
    
    for (const conn of tcpConnections) {
        if (conn.protocol === 'http/1.1') mapConnection(conn, false, extractHttp1);
        else if (conn.protocol === 'http2') mapConnection(conn, false, extractHttp2);
    }
    for (const conn of udpConnections) {
        if (conn.http3 && conn.http3.size > 0) mapConnection(conn, true, extractHttp3);
    }

    // Resolve all pending body extractions (decompression + base64) in parallel
    if (bodyTasks.length > 0) {
        await Promise.all(bodyTasks);
    }

    let globalEarliestMs = Number.MAX_SAFE_INTEGER;
    const reqs = Object.values(data.pages["page_0"].requests);
    if (reqs.length > 0) {
        reqs.sort((a, b) => a.time_start - b.time_start);
        
        let url = reqs[0].url;
        let start = reqs[0].time_start;
        for (const req of reqs) {
            const destHeader = req.headers.find(h => h.name.toLowerCase() === 'sec-fetch-dest');
            if (destHeader && destHeader.value === 'document') {
                url = req.url; start = req.time_start; break;
            }
            const ctHeader = req.responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
            if (ctHeader && ctHeader.value.includes('text/html') && req.status === 200) {
                url = req.url; start = req.time_start; break;
            }
        }
        data.pages["page_0"].url = url;
        data.pages["page_0"].title = url;
        
        // Find absolute earliest bounded time
        for (const req of reqs) {
            if (req.time_start > 0 && req.time_start < globalEarliestMs) globalEarliestMs = req.time_start;
            
            // Check connections for earlier times
            if (req.connection_id) {
                const conn = data.tcp_connections[req.connection_id] || data.quic_connections[req.connection_id];
                if (conn && conn.start_time > 0 && conn.start_time < globalEarliestMs) {
                    globalEarliestMs = conn.start_time;
                }
            }
            // Check DNS for earlier times
            if (req.dns_query_id) {
                const dnsObj = data.dns[req.dns_query_id];
                if (dnsObj && dnsObj.start_time > 0 && dnsObj.start_time < globalEarliestMs) {
                    globalEarliestMs = dnsObj.start_time;
                }
            }
        }
        if (globalEarliestMs === Number.MAX_SAFE_INTEGER) globalEarliestMs = start;
    }
    
    if (globalEarliestMs !== Number.MAX_SAFE_INTEGER) {
        data.pages["page_0"].startedDateTime = new Date(globalEarliestMs).toISOString();
    }
    
    return data;
}
