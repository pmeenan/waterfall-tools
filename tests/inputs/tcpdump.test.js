/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';
import { PcapParser } from '../../src/inputs/utilities/tcpdump/pcap-parser.js';
import { decodeHttp1 } from '../../src/inputs/utilities/tcpdump/http1-decoder.js';
import { HpackDecoder } from '../../src/inputs/utilities/tcpdump/hpack-decoder.js';
import { decodeHttp2 } from '../../src/inputs/utilities/tcpdump/http2-decoder.js';
import { QpackDecoder } from '../../src/inputs/utilities/tcpdump/qpack-decoder.js';
import { decodeHttp3 } from '../../src/inputs/utilities/tcpdump/http3-decoder.js';
import { decodePacketNumber, deriveTrafficKeys } from '../../src/inputs/utilities/tcpdump/quic-crypto.js';
import { decodeBase64Url, extractDohRequests } from '../../src/inputs/utilities/tcpdump/doh-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGENERATE_FIXTURES = process.env.REGENERATE_FIXTURES === 'true' || Boolean(process.env.UPDATE_FIXTURES);

describe('Tcpdump Processor', () => {

    it('Generates Valid HAR', async () => {
        const inputPath = path.join(__dirname, '../../Sample/Data/tcpdump/www.google.com-tcpdump.cap.gz');
        const fixturePath = path.join(__dirname, '../fixtures/tcpdump-google-har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'tcpdump' });
        const har = tool.getHar({ debug: true });

        // Dynamic assertions verifying parser integrity
        expect(har.log.version).toBe("1.2");
        expect(har.log.pages.length).toBe(1);
        expect(har.log.entries.length).toBeGreaterThanOrEqual(1);

        // Validate custom extensions
        expect(['TCP', 'QUIC']).toContain(har.log.entries[0]._protocol);

        // Verify that response bodies are extracted for at least some entries
        const entriesWithBody = har.log.entries.filter(
            e => e.response && e.response.content && e.response.content.text
        );
        expect(entriesWithBody.length).toBeGreaterThan(0);

        // Scrub dynamic keys before comparison
        har.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        har.log.entries.forEach(e => {
            e.startedDateTime = "SCRUBBED";
            e.time = 0;
            e.timings = {
                dns: -1,
                connect: -1,
                ssl: -1,
                send: 0,
                wait: 0,
                receive: 0
            };
            // Strip large body content to keep fixture manageable
            if (e.response && e.response.content) {
                delete e.response.content.text;
                delete e.response.content.encoding;
            }
            if (e._chunks) {
                e._chunks.forEach(c => {
                    delete c.inflated;
                });
            }
        });

        const scrubbedHarStr = JSON.parse(JSON.stringify(har));

        // Regenerate mode
        if (REGENERATE_FIXTURES) {
            fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
            fs.writeFileSync(fixturePath, JSON.stringify(scrubbedHarStr, null, 2), 'utf-8');
            console.log('Regenerated TCP Dump HAR Fixture');
            return;
        }

        expect(fs.existsSync(fixturePath)).toBe(true);
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        expect(scrubbedHarStr).toEqual(fixture);
    });

    it('T1: strips Ethernet trailer padding using IPv4 totalLen and IPv6 payloadLen', () => {
        const packets = [];
        const parser = new PcapParser((pkt) => packets.push(pkt));

        // Build a classic PCAP (little-endian magic 0xa1b2c3d4, linkType = 1 Ethernet)
        const globalHeader = new Uint8Array(24);
        const ghView = new DataView(globalHeader.buffer);
        ghView.setUint32(0, 0xa1b2c3d4, true);
        ghView.setUint16(4, 2, true);
        ghView.setUint16(6, 4, true);
        ghView.setUint32(16, 65535, true);
        ghView.setUint32(20, 1, true); // LINKTYPE_ETHERNET

        // 60-byte Ethernet frame carrying a 32-byte IPv4 packet (20B IPv4 + 8B UDP + 4B payload) + 14B Ethernet trailer padding
        const ethFrame = new Uint8Array(60);
        ethFrame[12] = 0x08; ethFrame[13] = 0x00; // EtherType IPv4
        const ipOffset = 14;
        ethFrame[ipOffset] = 0x45; // v4, IHL=5 (20 bytes)
        ethFrame[ipOffset + 2] = 0x00; ethFrame[ipOffset + 3] = 32; // totalLen = 32
        ethFrame[ipOffset + 9] = 17; // UDP
        ethFrame.set([192, 0, 2, 1], ipOffset + 12);
        ethFrame.set([198, 51, 100, 2], ipOffset + 16);
        const udpOffset = ipOffset + 20;
        ethFrame[udpOffset] = 0x13; ethFrame[udpOffset + 1] = 0x88; // srcPort 5000
        ethFrame[udpOffset + 2] = 0x00; ethFrame[udpOffset + 3] = 0x35; // dstPort 53
        ethFrame[udpOffset + 4] = 0x00; ethFrame[udpOffset + 5] = 12; // UDP len = 12 (8B hdr + 4B data)
        ethFrame.set([0xde, 0xad, 0xbe, 0xef], udpOffset + 8);
        // Fill Ethernet trailer padding with non-zero junk
        ethFrame.fill(0xff, ipOffset + 32);

        const pktRecord = new Uint8Array(16 + ethFrame.length);
        const prView = new DataView(pktRecord.buffer);
        prView.setUint32(0, 1700000000, true);
        prView.setUint32(4, 500000, true);
        prView.setUint32(8, ethFrame.length, true);
        prView.setUint32(12, ethFrame.length, true);
        pktRecord.set(ethFrame, 16);

        parser.push(globalHeader);
        parser.push(pktRecord);
        expect(packets.length).toBe(1);
        expect(Array.from(packets[0].payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('T2: handles PCAPNG if_tsresol, LINKTYPE_LINUX_SLL2 (276), and zero blockLength termination', () => {
        const packets = [];
        const parser = new PcapParser((pkt) => packets.push(pkt));

        // Section Header Block (28 bytes)
        const shb = new Uint8Array(28);
        const shbView = new DataView(shb.buffer);
        shbView.setUint32(0, 0x0a0d0d0a, true);
        shbView.setUint32(4, 28, true);
        shbView.setUint32(8, 0x1a2b3c4d, true);
        shbView.setUint16(12, 1, true);
        shbView.setUint16(14, 0, true);
        shbView.setInt32(16, -1, true);
        shbView.setInt32(20, -1, true);
        shbView.setUint32(24, 28, true);

        // Interface Description Block with linkType=276 (LINUX_SLL2) and option if_tsresol=9 (10^-9s nanoseconds)
        // 16B fixed + 8B opt(code=9, len=1, val=9, pad) + 4B end-of-opts + 4B trailing len = 32 bytes
        const idb = new Uint8Array(32);
        const idbView = new DataView(idb.buffer);
        idbView.setUint32(0, 0x00000001, true);
        idbView.setUint32(4, 32, true);
        idbView.setUint16(8, 276, true); // LINKTYPE_LINUX_SLL2
        idbView.setUint32(12, 65535, true);
        idbView.setUint16(16, 9, true); // opt_code = if_tsresol (9)
        idbView.setUint16(18, 1, true); // opt_len = 1
        idb[20] = 9; // 10^-9 (nanoseconds)
        idbView.setUint32(28, 32, true);

        // Build SLL2 packet (20B SLL2 header + 20B IPv4 + 8B UDP + 2B data = 50B, padded to 52B)
        const sll2Pkt = new Uint8Array(50);
        sll2Pkt[0] = 0x08; sll2Pkt[1] = 0x00; // protocol IPv4 at bytes 0-1 in SLL2
        const ipOff = 20;
        sll2Pkt[ipOff] = 0x45;
        sll2Pkt[ipOff + 3] = 30; // totalLen = 30
        sll2Pkt[ipOff + 9] = 17; // UDP
        sll2Pkt.set([10, 0, 0, 1], ipOff + 12);
        sll2Pkt.set([10, 0, 0, 2], ipOff + 16);
        sll2Pkt[ipOff + 20] = 0x04; sll2Pkt[ipOff + 21] = 0xd2; // 1234
        sll2Pkt[ipOff + 22] = 0x00; sll2Pkt[ipOff + 23] = 0x50; // 80
        sll2Pkt[ipOff + 25] = 10; // UDP len = 10
        sll2Pkt.set([0xca, 0xfe], ipOff + 28);

        // Enhanced Packet Block: 32B fixed/trailer + 52B padded packet = 84B
        const epb = new Uint8Array(84);
        const epbView = new DataView(epb.buffer);
        epbView.setUint32(0, 0x00000006, true);
        epbView.setUint32(4, 84, true);
        epbView.setUint32(8, 0, true); // interfaceId = 0
        // Timestamp = 1_500_000_000 ns = 1.5 seconds
        const tsNs = 1500000000n;
        epbView.setUint32(12, Number(tsNs >> 32n), true);
        epbView.setUint32(16, Number(tsNs & 0xffffffffn), true);
        epbView.setUint32(20, sll2Pkt.length, true);
        epbView.setUint32(24, sll2Pkt.length, true);
        epb.set(sll2Pkt, 28);
        epbView.setUint32(80, 84, true);

        // Corrupt trailing block with blockLength = 0 (must terminate cleanly without infinite loop)
        const zeroBlock = new Uint8Array(16);

        parser.push(shb);
        parser.push(idb);
        parser.push(epb);
        parser.push(zeroBlock);
        expect(packets.length).toBe(1);
        expect(packets[0].time).toBeCloseTo(1.5, 6);
        expect(Array.from(packets[0].payload)).toEqual([0xca, 0xfe]);
    });

    it('T3: decodes HTTP/1.1 keep-alive pipelined messages, chunked transfer encoding, and 1xx/204/HEAD responses', () => {
        const enc = new TextEncoder();
        const clientChunks = [
            { time: 1.0, bytes: enc.encode('GET /first HTTP/1.1\r\nHost: example.com\r\n\r\n') },
            { time: 2.0, bytes: enc.encode('HEAD /second HTTP/1.1\r\nHost: example.com\r\n\r\n') },
            { time: 3.0, bytes: enc.encode('GET /third HTTP/1.1\r\nHost: example.com\r\n\r\n') }
        ];
        const serverChunks = [
            // Response 1: 103 Early Hints followed by 200 OK with chunked body across fragments
            { time: 1.1, bytes: enc.encode('HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nHello\r\n') },
            { time: 1.2, bytes: enc.encode('6\r\n World\r\n0\r\nX-Trailer: done\r\n\r\n') },
            // Response 2: HEAD 200 response with Content-Length: 5000 (must not consume next response as body!)
            { time: 2.1, bytes: enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n') },
            // Response 3: 204 No Content
            { time: 3.1, bytes: enc.encode('HTTP/1.1 204 No Content\r\n\r\n') }
        ];

        const res = decodeHttp1(clientChunks, serverChunks);
        expect(res.requests.length).toBe(3);
        expect(res.responses.length).toBe(3);

        // Response 1: 200 OK (103 stored on informational), de-chunked body = "Hello World"
        expect(res.responses[0].firstLine).toBe('HTTP/1.1 200 OK');
        expect(res.responses[0].informational?.length).toBe(1);
        const body0 = new TextDecoder().decode(
            new Uint8Array(res.responses[0].data.flatMap(d => Array.from(d.bytes)))
        );
        expect(body0).toBe('Hello World');
        expect(res.responses[0].trailers).toEqual([{ name: 'X-Trailer', value: 'done' }]);

        // Response 2: HEAD response has 0 body bytes
        expect(res.responses[1].firstLine).toBe('HTTP/1.1 200 OK');
        expect(res.responses[1].data.length).toBe(0);

        // Response 3: 204 No Content
        expect(res.responses[2].firstLine).toBe('HTTP/1.1 204 No Content');
        expect(res.responses[2].data.length).toBe(0);
    });

    it('T5: guards HPACK and QPACK readInt against integer overflow', () => {
        const hpack = new HpackDecoder();
        const qpack = new QpackDecoder();

        // Construct a varint with 10 continuation bytes (0xFF prefix + ten 0xFF bytes + 0x01)
        const huge = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
        expect(hpack.decode(huge)).toEqual([]);
        expect(qpack.readInt(huge, 0, 7, 0x7f)).toBeNull();
    });

    it('T6: resolves QPACK dynamic table relative indexing in encoder stream and header blocks', () => {
        const qpack = new QpackDecoder();
        qpack.setMaxTableCapacity(4096);

        // Encoder stream:
        // 1. Set capacity = 256: 001_11111, 256-31 = 225 (0xe1, 0x01)
        // 2. Insert literal name "x-first" (len 7) = "one" (len 3) -> absIndex 0
        // 3. Insert literal name "x-second" (len 8) = "two" (len 3) -> absIndex 1
        // 4. Insert with dynamic name ref relative idx 1 (refers to absIndex 0 "x-first") = "uno" (len 3) -> absIndex 2
        // 5. Duplicate relative idx 1 (refers to absIndex 1 "x-second: two") -> absIndex 3
        const encBytes = new Uint8Array([
            0x3f, 0xe1, 0x01,
            0x47, ...new TextEncoder().encode('x-first'), 0x03, ...new TextEncoder().encode('one'),
            0x48, ...new TextEncoder().encode('x-second'), 0x03, ...new TextEncoder().encode('two'),
            0x81, 0x03, ...new TextEncoder().encode('uno'),
            0x01
        ]);
        qpack.processEncoder(encBytes, false, () => 1.0);
        expect(qpack.insertsCount).toBe(4);

        // Header block with RequiredInsertCount = 4 (encoded = 4 + 1 = 5), S = 1, deltaBase = 1 => base = 4 - 1 - 1 = 2
        // - Pre-base indexed dynamic ref idx=0 -> base - 1 - 0 = absIndex 1 ("x-second: two")
        // - Pre-base indexed dynamic ref idx=1 -> base - 1 - 1 = absIndex 0 ("x-first: one")
        // - Post-base indexed dynamic ref idx=0 -> base + 0 = absIndex 2 ("x-first: uno")
        // - Post-base indexed dynamic ref idx=1 -> base + 1 = absIndex 3 ("x-second: two")
        const hdrBlock = new Uint8Array([
            0x05, // Encoded RIC = 5 -> RIC = 4
            0x81, // S=1, deltaBase=1 -> base = 2
            0x80, // Indexed dynamic pre-base 0 -> abs 1
            0x81, // Indexed dynamic pre-base 1 -> abs 0
            0x10, // Indexed dynamic post-base 0 -> abs 2
            0x11  // Indexed dynamic post-base 1 -> abs 3
        ]);
        const decoded = qpack.decodeHeaders(hdrBlock, 2.0);
        expect(decoded).toEqual([
            { name: 'x-second', value: 'two' },
            { name: 'x-first', value: 'one' },
            { name: 'x-first', value: 'uno' },
            { name: 'x-second', value: 'two' }
        ]);
    });

    it('separates 1xx Early Hints from final response headers in HTTP/2 and HTTP/3', () => {
        // HTTP/2: Stream 1 with client HEADERS, server 103 HEADERS (at t=1.1), server 200 HEADERS (at t=1.5), server DATA (at t=1.6)
        const makeH2Frame = (type, flags, streamId, payload) => {
            const out = new Uint8Array(9 + payload.length);
            out[0] = (payload.length >>> 16) & 0xff;
            out[1] = (payload.length >>> 8) & 0xff;
            out[2] = payload.length & 0xff;
            out[3] = type;
            out[4] = flags;
            new DataView(out.buffer).setUint32(5, streamId, false);
            out.set(payload, 9);
            return out;
        };
        const preface = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
        // Client HEADERS: :method GET (0x82), :path / (0x84), :scheme https (0x87)
        const clientH2 = new Uint8Array(preface.length + 12);
        clientH2.set(preface, 0);
        clientH2.set(makeH2Frame(0x01, 0x05, 1, new Uint8Array([0x82, 0x84, 0x87])), preface.length);

        // Server 103 Early Hints: literal :status (index 8 -> 0x08) = "103" (len 3)
        const h103 = makeH2Frame(0x01, 0x04, 1, new Uint8Array([0x08, 0x03, 0x31, 0x30, 0x33]));
        // Server 200 OK: indexed :status 200 (index 8 -> 0x88)
        const h200 = makeH2Frame(0x01, 0x04, 1, new Uint8Array([0x88]));
        // Server DATA: 4 bytes
        const dFrame = makeH2Frame(0x00, 0x01, 1, new Uint8Array([1, 2, 3, 4]));

        const h2Res = decodeHttp2(
            [{ time: 1.0, bytes: clientH2 }],
            [
                { time: 1.1, bytes: h103 },
                { time: 1.5, bytes: h200 },
                { time: 1.6, bytes: dFrame }
            ]
        );
        const s1 = h2Res.streams.get(1);
        expect(s1.informational.length).toBe(1);
        expect(s1.informational[0].headers).toContainEqual({ name: ':status', value: '103' });
        expect(s1.headers.server).toContainEqual({ name: ':status', value: '200' });
        expect(s1.headers.serverTime).toBe(1.5);

        // HTTP/3: Stream 0 with client HEADERS, server 103 HEADERS (at t=2.1), server 200 HEADERS (at t=2.5), server DATA across 2 packets (t=2.6, t=2.7)
        // QPACK static: :method GET = 17 (0xd1), :scheme https = 23 (0xd7), :path / = 1 (0xc1)
        // QPACK static: :status 103 = 24 (0xd8), :status 200 = 25 (0xd9)
        const h3ClientBuf = new Uint8Array([0x01, 0x05, 0x00, 0x00, 0xd1, 0xd7, 0xc1]);
        const h3Server103 = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0xd8]);
        const h3Server200 = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0xd9]);
        const h3DataHdr = new Uint8Array([0x00, 0x06, 10, 20, 30]);
        const h3DataTail = new Uint8Array([40, 50, 60]);

        const quicStreams = new Map([
            [0, [
                { isClient: true, offset: 0, time: 2.0, data: h3ClientBuf },
                { isClient: false, offset: 0, time: 2.1, data: h3Server103 },
                { isClient: false, offset: h3Server103.length, time: 2.5, data: h3Server200 },
                { isClient: false, offset: h3Server103.length + h3Server200.length, time: 2.6, data: h3DataHdr },
                { isClient: false, offset: h3Server103.length + h3Server200.length + h3DataHdr.length, time: 2.7, data: h3DataTail }
            ]]
        ]);
        const h3Map = decodeHttp3(quicStreams);
        const h3Stream = h3Map.get(0);
        expect(h3Stream.informational.length).toBe(1);
        expect(h3Stream.informational[0].headers).toContainEqual({ name: ':status', value: '103' });
        expect(h3Stream.responses.length).toBe(1);
        expect(h3Stream.responses[0].headers).toContainEqual({ name: ':status', value: '200' });
        expect(h3Stream.firstServerTime).toBe(2.5);
        expect(h3Stream.lastServerTime).toBe(2.7);
        expect(h3Stream.responses[0].chunks.map(c => ({ time: c.time, length: c.length }))).toEqual([
            { time: 2.6, length: 3 },
            { time: 2.7, length: 3 }
        ]);
    });

    it('T8: reconstructs truncated QUIC packet numbers (RFC 9000 §A.3) and derives AES-256-GCM SHA-384 keys', async () => {
        // RFC 9000 Appendix A.3 example: largest_pn = 0xa82f30ea, truncated = 0x9b32 (16-bit) -> 0xa82f9b32
        expect(decodePacketNumber(0xa82f30ea, 0x9b32, 16)).toBe(0xa82f9b32);
        // Wrap-around across 1-byte boundary: largest_pn = 0xff, truncated = 0x00 (8-bit) -> 0x100
        expect(decodePacketNumber(0xff, 0x00, 8)).toBe(0x100);

        // 48-byte secret -> SHA-384 / 32-byte key (AES-256-GCM)
        const secret48 = new Uint8Array(48).fill(0x42);
        const keys = await deriveTrafficKeys(secret48);
        expect(keys.key.length).toBe(32);
        expect(keys.hp.length).toBe(32);
        expect(keys.iv.length).toBe(12);
        expect(keys.hpCryptoKey).toBeTruthy();
        expect(keys.aeadCryptoKey).toBeTruthy();
    });

    it('T10: decodes Base64URL strings with multiple underscores and preserves HTTP/2 DoH GET timestamps', () => {
        // Buffer [0xfb, 0xff, 0xbf, 0xfb] -> standard base64 "+/+/_7==" -> base64url "-_-_-w"
        const decoded = decodeBase64Url('-_-_-w');
        expect(Array.from(decoded)).toEqual([0xfb, 0xff, 0xbf, 0xfb]);

        // Minimal DNS query for "a.com" (A) in base64url + DNS response with 93.184.216.34
        const dnsQuery = new Uint8Array([
            0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x01, 0x61, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01
        ]);
        const dnsResponse = new Uint8Array([
            0x00, 0x00, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x01, 0x61, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01,
            0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
            93, 184, 216, 34
        ]);
        const b64u = Buffer.from(dnsQuery).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const tcpConn = {
            protocol: 'http2',
            http2: {
                streams: new Map([
                    [1, {
                        headers: {
                            client: [
                                { name: ':method', value: 'GET' },
                                { name: ':path', value: `/dns-query?dns=${b64u}` }
                            ],
                            server: [
                                { name: ':status', value: '200' },
                                { name: 'content-type', value: 'application/dns-message' }
                            ],
                            clientTime: 42.5,
                            serverTime: 42.6
                        },
                        data: {
                            client: [],
                            server: [{ time: 42.65, bytes: dnsResponse, length: dnsResponse.length }]
                        }
                    }]
                ])
            }
        };
        const lookups = [];
        const dnsRegistry = {
            addCompletedLookup(domain, ips, requestTime, responseTime, protocol) {
                lookups.push({ domain, ips, requestTime, responseTime, protocol });
            }
        };
        extractDohRequests([tcpConn], dnsRegistry);
        expect(lookups.length).toBe(1);
        expect(lookups[0].domain).toBe('a.com');
        expect(lookups[0].ips).toEqual(['93.184.216.34']);
        expect(lookups[0].requestTime).toBe(42.5);
        expect(lookups[0].responseTime).toBe(42.65);
    });
});
