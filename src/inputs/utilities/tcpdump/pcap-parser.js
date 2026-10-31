/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

// Link-layer header types (https://www.tcpdump.org/linktypes.html)
const LINKTYPE_NULL = 0;          // BSD loopback (4-byte host-endian AF_ value)
const LINKTYPE_ETHERNET = 1;
const LINKTYPE_RAW = 101;         // Raw IPv4/IPv6, no link header
const LINKTYPE_LINUX_SLL = 113;   // Linux cooked capture v1
const LINKTYPE_IPV4 = 228;
const LINKTYPE_IPV6 = 229;
const LINKTYPE_LINUX_SLL2 = 276;  // Linux cooked capture v2

const DEFAULT_TS_DIVISOR = 1000000n; // PCAPNG default if_tsresol = 6 (microseconds)

/**
 * Decodes a PCAPNG `if_tsresol` option byte into the number of timestamp
 * units per second (as a BigInt). The MSB selects the base: 0 → 10^-n,
 * 1 → 2^-n. Returns null for values that can't be represented sanely.
 */
export function tsresolToUnitsPerSecond(value) {
    const exp = value & 0x7F;
    if (value & 0x80) {
        if (exp > 63) return null;
        return 1n << BigInt(exp);
    }
    if (exp > 18) return null;
    return 10n ** BigInt(exp);
}

export class PcapParser {
    constructor(onPacket) {
        this.onPacket = onPacket;
        this.buffer = new Uint8Array(0);
        this.state = 'MAGIC';

        // Context
        this.isPcapng = false;
        this.littleEndian = true;
        this.nanoSecs = false;

        // Global PCAP settings
        this.linkType = null;
        this.snapLen = null;

        // PCAPNG interfaces declared by Interface Description Blocks in the
        // current section: [{ linkType, unitsPerSecond }]. Reset on every SHB.
        this.interfaces = [];
    }

    push(chunk) {
        // Append chunk to static buffer
        const newBuf = new Uint8Array(this.buffer.length + chunk.length);
        newBuf.set(this.buffer);
        newBuf.set(chunk, this.buffer.length);
        this.buffer = newBuf;

        this._parse();
    }

    _parse() {
        let offset = 0;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);

        while (offset < this.buffer.length) {
            if (this.state === 'MAGIC') {
                if (this.buffer.length - offset < 4) break;
                const magic = view.getUint32(offset, false);

                if (magic === 0xa1b2c3d4) { this.isPcapng = false; this.littleEndian = false; this.nanoSecs = false; }
                else if (magic === 0xd4c3b2a1) { this.isPcapng = false; this.littleEndian = true; this.nanoSecs = false; }
                else if (magic === 0xa1b23c4d) { this.isPcapng = false; this.littleEndian = false; this.nanoSecs = true; }
                else if (magic === 0x4d3cb2a1) { this.isPcapng = false; this.littleEndian = true; this.nanoSecs = true; }
                else if (magic === 0x0A0D0D0A) { this.isPcapng = true; }
                else {
                    throw new Error(`Unknown PCAP magic number: 0x${magic.toString(16)}`);
                }

                if (this.isPcapng) {
                    this.state = 'PCAPNG_BLOCK';
                } else {
                    this.state = 'PCAP_GLOBAL_HEADER';
                }
            } else if (this.state === 'PCAP_GLOBAL_HEADER') {
                if (this.buffer.length - offset < 24) break; // 24 bytes is PCAP global header

                this.snapLen = view.getUint32(offset + 16, this.littleEndian);
                this.linkType = view.getUint32(offset + 20, this.littleEndian) & 0x0FFFFFFF;

                offset += 24;
                this.state = 'PCAP_PACKET';
            } else if (this.state === 'PCAP_PACKET') {
                if (this.buffer.length - offset < 16) break; // 16 bytes is packet header

                const tsSec = view.getUint32(offset, this.littleEndian);
                const tsUsecOrNsec = view.getUint32(offset + 4, this.littleEndian);
                const inclLen = view.getUint32(offset + 8, this.littleEndian);
                const origLen = view.getUint32(offset + 12, this.littleEndian);

                if (this.buffer.length - (offset + 16) < inclLen) break;

                offset += 16;
                const packetData = this.buffer.subarray(offset, offset + inclLen);

                const tsUsec = this.nanoSecs ? Math.floor(tsUsecOrNsec / 1000) : tsUsecOrNsec;
                this._processPacketData(packetData, tsSec, tsUsec, origLen, this.linkType);

                offset += inclLen;
            } else if (this.state === 'PCAPNG_BLOCK') {
                if (this.buffer.length - offset < 12) break;
                // SHB type 0x0A0D0D0A is a byte-order palindrome, so it can be
                // read before the section's endianness is known.
                const blockType = view.getUint32(offset, this.littleEndian);

                if (blockType === 0x0A0D0D0A) { // Section Header Block
                    // Endianness is defined by the byte-order magic at offset +8
                    const magic = view.getUint32(offset + 8, false);
                    if (magic === 0x1A2B3C4D) this.littleEndian = false;
                    else if (magic === 0x4D3C2B1A) this.littleEndian = true;
                    // A new section starts a fresh interface list
                    this.interfaces = [];
                }
                const blockLength = view.getUint32(offset + 4, this.littleEndian);

                // Corrupt/hostile block length: a zero (or < minimum block size)
                // length would never advance `offset` and spin forever. Bail out
                // of the rest of the capture instead.
                if (blockLength < 12 || (blockLength & 0x03) !== 0) {
                    this.state = 'ERROR';
                    offset = this.buffer.length;
                    break;
                }

                if (this.buffer.length - offset < blockLength) break;

                if (blockType === 0x00000006) { // Enhanced Packet Block (EPB)
                    if (blockLength >= 32) {
                        const interfaceId = view.getUint32(offset + 8, this.littleEndian);
                        const tsHigh = view.getUint32(offset + 12, this.littleEndian);
                        const tsLow = view.getUint32(offset + 16, this.littleEndian);
                        const capturedLen = view.getUint32(offset + 20, this.littleEndian);
                        const origLen = view.getUint32(offset + 24, this.littleEndian);

                        // Never read past the end of the block
                        const dataEnd = Math.min(offset + 28 + capturedLen, offset + blockLength - 4);
                        const packetData = this.buffer.subarray(offset + 28, dataEnd);

                        const iface = this.interfaces[interfaceId];
                        const unitsPerSecond = (iface && iface.unitsPerSecond) || DEFAULT_TS_DIVISOR;
                        const tsBig = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
                        const tsSec = Number(tsBig / unitsPerSecond);
                        const tsUsec = Number(((tsBig % unitsPerSecond) * 1000000n) / unitsPerSecond);

                        // EPBs without a matching IDB default to Ethernet
                        const pcapngLinkType = iface ? iface.linkType : LINKTYPE_ETHERNET;

                        this._processPacketData(packetData, tsSec, tsUsec, origLen, pcapngLinkType);
                    }
                } else if (blockType === 0x00000003) { // Simple Packet Block (SPB)
                    if (blockLength >= 16) {
                        const origLen = view.getUint32(offset + 8, this.littleEndian);
                        const dataEnd = Math.min(offset + 12 + origLen, offset + blockLength - 4);
                        const packetData = this.buffer.subarray(offset + 12, dataEnd);
                        const iface = this.interfaces[0];
                        // SPBs carry no timestamp; emit with time 0 so they're at least decodable
                        this._processPacketData(packetData, 0, 0, origLen, iface ? iface.linkType : LINKTYPE_ETHERNET);
                    }
                } else if (blockType === 0x00000001) { // Interface Description Block (IDB)
                    if (blockLength >= 20) {
                        const linkType = view.getUint16(offset + 8, this.littleEndian);
                        let unitsPerSecond = DEFAULT_TS_DIVISOR;
                        // Walk options looking for if_tsresol (code 9)
                        let optOffset = offset + 16;
                        const optEnd = offset + blockLength - 4;
                        while (optOffset + 4 <= optEnd) {
                            const code = view.getUint16(optOffset, this.littleEndian);
                            const len = view.getUint16(optOffset + 2, this.littleEndian);
                            if (code === 0) break; // opt_endofopt
                            if (optOffset + 4 + len > optEnd) break;
                            if (code === 9 && len >= 1) {
                                const resolved = tsresolToUnitsPerSecond(this.buffer[optOffset + 4]);
                                if (resolved) unitsPerSecond = resolved;
                            }
                            optOffset += 4 + ((len + 3) & ~3);
                        }
                        this.interfaces.push({ linkType, unitsPerSecond });
                    }
                }

                offset += blockLength;
            } else {
                // ERROR state: discard everything
                offset = this.buffer.length;
                break;
            }
        }

        if (offset > 0) {
            this.buffer = this.buffer.slice(offset);
        }
    }

    _processPacketData(buffer, tsSec, tsUsec, origLen, linkType) {
        if (buffer.length === 0) return;

        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        let pOffset;

        const ethResult = {};

        // Parse Hardware Link Layer
        if (linkType === LINKTYPE_ETHERNET) { // Ethernet II
            if (buffer.length < 14) return;
            // Dest MAC (6), Src MAC (6)
            ethResult.dstMac = this._mac(buffer.subarray(0, 6));
            ethResult.srcMac = this._mac(buffer.subarray(6, 12));

            pOffset = 12;
            ethResult.type = view.getUint16(pOffset, false);
            pOffset += 2;

            // VLAN tagging (802.1Q / 802.1ad QinQ)
            while (ethResult.type === 0x8100 || ethResult.type === 0x88A8) {
                if (buffer.length < pOffset + 4) return;
                pOffset += 2; // skip TCI
                ethResult.type = view.getUint16(pOffset, false);
                pOffset += 2;
            }
        } else if (linkType === LINKTYPE_LINUX_SLL) { // Linux cooked capture (SLL)
            if (buffer.length < 16) return;
            const packetType = view.getUint16(0, false);
            // packetType 0 = unicast to us, 4 = sent by us
            ethResult.direction = packetType === 0 ? 'in' : (packetType === 4 ? 'out' : 'unknown');
            ethResult.type = view.getUint16(14, false); // Protocol follows explicitly
            pOffset = 16;
        } else if (linkType === LINKTYPE_LINUX_SLL2) { // Linux cooked capture v2
            if (buffer.length < 20) return;
            ethResult.type = view.getUint16(0, false); // Protocol type first in SLL2
            const packetType = buffer[10];
            ethResult.direction = packetType === 0 ? 'in' : (packetType === 4 ? 'out' : 'unknown');
            pOffset = 20;
        } else if (linkType === LINKTYPE_RAW || linkType === LINKTYPE_IPV4 || linkType === LINKTYPE_IPV6) {
            // Raw IP: version nibble decides the protocol
            const version = buffer[0] >> 4;
            if (version === 4) ethResult.type = 0x0800;
            else if (version === 6) ethResult.type = 0x86DD;
            else return;
            pOffset = 0;
        } else if (linkType === LINKTYPE_NULL) {
            // BSD loopback: 4-byte address family in the *capturing host's* byte order.
            if (buffer.length < 4) return;
            let family = view.getUint32(0, true);
            if (family > 0xFFFF) family = view.getUint32(0, false);
            if (family === 2) ethResult.type = 0x0800;
            else if (family === 24 || family === 28 || family === 30) ethResult.type = 0x86DD; // AF_INET6 varies per BSD/macOS
            else return;
            pOffset = 4;
        } else {
            // Unsupported link type, skip packet for now
            return;
        }

        let ipResult = null;
        // End of the IP datagram inside `buffer`. Anything after this is
        // link-layer padding (e.g. Ethernet pads frames to 60 bytes, so a bare
        // 40-byte TCP ACK/FIN carries 6 trailing junk bytes that must not leak
        // into the TCP payload).
        let ipEnd = buffer.length;
        if (ethResult.type === 0x0800) { // IPv4
            if (buffer.length - pOffset < 20) return;
            const b = view.getUint8(pOffset);
            const ihl = (b & 0x0F) * 4; // IP Header length in bytes
            if (ihl < 20) return;

            ipResult = {
                version: 4,
                srcIP: this._ipv4(buffer.subarray(pOffset + 12, pOffset + 16)),
                dstIP: this._ipv4(buffer.subarray(pOffset + 16, pOffset + 20)),
                protocol: view.getUint8(pOffset + 9), // Protocol (6=TCP, 17=UDP)
                totalLen: view.getUint16(pOffset + 2, false)
            };
            // totalLen of 0 is used by TSO/GSO offloaded captures; trust the capture length then.
            if (ipResult.totalLen >= ihl) {
                ipEnd = Math.min(buffer.length, pOffset + ipResult.totalLen);
            }
            pOffset += ihl;

        } else if (ethResult.type === 0x86DD) { // IPv6
            if (buffer.length - pOffset < 40) return;
            ipResult = {
                version: 6,
                protocol: view.getUint8(pOffset + 6), // Next Header
                srcIP: this._ipv6(buffer.subarray(pOffset + 8, pOffset + 24)),
                dstIP: this._ipv6(buffer.subarray(pOffset + 24, pOffset + 40)),
                payloadLen: view.getUint16(pOffset + 4, false)
            };
            // payloadLen of 0 indicates a jumbogram / offloaded capture; trust the capture length then.
            if (ipResult.payloadLen > 0) {
                ipEnd = Math.min(buffer.length, pOffset + 40 + ipResult.payloadLen);
            }
            pOffset += 40;
            // Note: Does not currently traverse IPv6 extension headers, assuming direct Protocol follows.
        }

        if (!ipResult) return; // Not an IP packet we monitor
        if (pOffset > ipEnd) return;

        let transportResult = null;
        let payload = null;

        if (ipResult.protocol === 6) { // TCP
            if (ipEnd - pOffset < 20) return;
            transportResult = {
                type: 'TCP',
                srcPort: view.getUint16(pOffset, false),
                dstPort: view.getUint16(pOffset + 2, false),
                seq: view.getUint32(pOffset + 4, false),
                ack: view.getUint32(pOffset + 8, false),
            };

            const offsetAndFlags = view.getUint16(pOffset + 12, false);
            const dataOffset = (offsetAndFlags >> 12) * 4; // Length of TCP header in bytes
            transportResult.flags = {
                FIN: !!(offsetAndFlags & 0x0001),
                SYN: !!(offsetAndFlags & 0x0002),
                RST: !!(offsetAndFlags & 0x0004),
                PSH: !!(offsetAndFlags & 0x0008),
                ACK: !!(offsetAndFlags & 0x0010),
                URG: !!(offsetAndFlags & 0x0020),
            };

            pOffset += dataOffset;
            // Segment payload is bounded by the IP datagram length, never the frame length
            payload = pOffset <= ipEnd ? buffer.subarray(pOffset, ipEnd) : new Uint8Array(0);
        } else if (ipResult.protocol === 17) { // UDP
            if (ipEnd - pOffset < 8) return;
            transportResult = {
                type: 'UDP',
                srcPort: view.getUint16(pOffset, false),
                dstPort: view.getUint16(pOffset + 2, false),
                len: view.getUint16(pOffset + 4, false)
            };

            pOffset += 8;
            const udpEnd = transportResult.len >= 8 ? Math.min(ipEnd, pOffset + transportResult.len - 8) : ipEnd;
            payload = buffer.subarray(pOffset, udpEnd);
        }

        if (!transportResult) return; // Ignore ICMP, etc.

        const packet = {
            time_sec: tsSec,
            time_usec: tsUsec,
            time: tsSec + (tsUsec / 1000000), // Fractional exact timestamp
            origLen: origLen,
            ethernet: ethResult,
            ip: ipResult,
            transport: transportResult,
            payload: payload
        };

        if (this.onPacket) this.onPacket(packet);
    }

    _mac(buf) {
        return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(':');
    }

    _ipv4(buf) {
        return Array.from(buf).join('.');
    }

    _ipv6(buf) {
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(((buf[i] << 8) | buf[i+1]).toString(16));
        }
        return parts.join(':');
    }
}
