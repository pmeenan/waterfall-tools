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
                let klIsGz = false;
                let klStream = keyLogInput;
                let klFsStream = null;
                
                if (typeof keyLogInput === 'string') {
                    const fs = await import('node:fs');
                    klIsGz = keyLogInput.endsWith('.gz');
                    const { Readable } = await import('node:stream');
                    klFsStream = fs.createReadStream(keyLogInput);
                    klStream = Readable.toWeb(klFsStream);
                } else {
                    klIsGz = options.keyLogIsGz === true;
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
            } catch (e) {
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
                
                // Feed client packets
                for (let chunk of conn.clientFlow.contiguousChunks) {
                    await decoder.push(0, chunk.bytes, chunk.time);
                }
                // Feed server packets
                for (let chunk of conn.serverFlow.contiguousChunks) {
                    await decoder.push(1, chunk.bytes, chunk.time);
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
                console.error("Protocol Decoded Error:", e);
            }
        }
        
        // Identify DNS over HTTPS (DoH) mapped onto HTTP connections
        try {
            extractDohRequests(tcpConnections, dnsRegistry);
        } catch(e) {
            console.error("DoH Extraction Error:", e);
        }
        
        const udpConnections = udpReconstructor.getConnections();
        console.log(`[tcpdump.js] Start routing ${udpConnections.length} UDP connections`);
        let udpCount = 0;
        for (let i = 0; i < udpConnections.length; i++) {
            const conn = udpConnections[i];
            try {
                console.log(`[tcpdump.js] Processing UDP ${i}/${udpConnections.length}...`);
                await decodeUdpProtocol(conn, keyLogMap, dnsRegistry);
                console.log(`[tcpdump.js] Processed UDP ${i}.`);
                udpCount++;
            } catch (e) {
                 console.error("UDP Decode Error:", e);
            }
        }
        console.log(`[tcpdump.js] Successfully verified ${udpCount} UDP connections`);

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
                      dnsTimeMs = dnsRecord.reqTime * 1000;
                      dnsEndTimeMs = dnsRecord.resTime * 1000;
                 }
            }
            
            let firstDataTimeMs = -1;
            let lastDataTimeMs = -1;
            let bytesIn = 0;
            
            if (req.data && req.data.length > 0) {
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
            if (req.responseHeaders) {
                if (Array.isArray(req.responseHeaders)) {
                    resHeaders = req.responseHeaders;
                } else if (typeof req.responseHeaders === 'object') {
                    for (const [name, val] of Object.entries(req.responseHeaders)) {
                        resHeaders.push({name, value: val.toString()});
                    }
                }
            }
            
            // Standard Time mappings
            let send = 0; // Upload time
            let dns = (dnsTimeMs > 0 && dnsEndTimeMs > 0) ? Math.max(0, dnsEndTimeMs - dnsTimeMs) : -1;
            let connect = (connectTimeMs > 0 && connectEndTimeMs > 0) ? Math.max(0, connectEndTimeMs - connectTimeMs) : -1;
            let ssl = (sslStartTimeMs > 0 && connectEndTimeMs > 0) ? Math.max(0, connectEndTimeMs - sslStartTimeMs) : -1; 
            
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
                        mimeType: "",
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
                httpVersion: "HTTP/1.1"
            });
        }
        return reqs;
    };
    
    // HTTP/2 & 3 Map Extractor
    const extractHttp23 = (conn) => {
        let streams = conn.http2 ? conn.http2.streams : (conn.http3 ? conn.http3 : null);
        if (!streams) return null;
        
        let reqs = [];
        for (const [id, stream] of streams.entries()) {
            if (!stream.headers || stream.headers.length === 0) continue; // Not a fully formed request stream
            
            let method = stream.headers.find(h => h.name === ':method')?.value || 'GET';
            let path = stream.headers.find(h => h.name === ':path')?.value || '/';
            let auth = stream.headers.find(h => h.name === ':authority')?.value || conn.serverIp;
            let scheme = stream.headers.find(h => h.name === ':scheme')?.value || 'https';
            let status = 200;
            
            let resHeaders = [];
            let dataBlocks = [];
            
            if (stream.responses) {
                 for (const res of stream.responses) {
                      if (res.headers) {
                           resHeaders = res.headers;
                           status = parseInt(resHeaders.find(h => h.name === ':status')?.value) || 200;
                      }
                      if (res.data) dataBlocks.push({ time: res.time || stream.time, length: res.data.length, bytes: res.data });
                 }
            }
            
            reqs.push({
                time: stream.time,
                method: method,
                url: `${scheme}://${auth}${path}`,
                headers: stream.headers.filter(h => !h.name.startsWith(':')),
                responseHeaders: resHeaders.filter(h => !h.name.startsWith(':')),
                statusCode: status,
                data: dataBlocks,
                httpVersion: conn.http2 ? "HTTP/2" : "HTTP/3"
            });
        }
        return reqs;
    };
    
    // Process TCP Connections
    for (const conn of tcpConnections) {
        if (conn.protocol === 'http/1.1') {
             mapConnection(conn, false, extractHttp1);
        } else if (conn.protocol === 'http2') {
             mapConnection(conn, false, extractHttp23);
        }
    }
    
    // Process UDP Connections
    for (const conn of udpConnections) {
        if (conn.http3 && conn.http3.size > 0) {
            mapConnection(conn, true, extractHttp23);
        }
    }
    
    // Chronological Sort
    entries.sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
    
    // Assign proper references and Page Entry
    let pageStartedDateTime = new Date().toISOString();
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
