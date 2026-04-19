/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
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

        // PCAPNG temporary states
        // TODO: Map interfaces from IDBs accurately rather than assuming Ethernet for all EPBs
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
                this.linkType = view.getUint32(offset + 20, this.littleEndian);
                
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
                const blockType = view.getUint32(offset, this.littleEndian);
                
                let blockLength;
                if (blockType === 0x0A0D0D0A) { // Section Header Block
                     // We need to sniff endianness inside SHB magic at offset +8
                     const magic = view.getUint32(offset + 8, false);
                     if (magic === 0x1A2B3C4D) this.littleEndian = false;
                     else if (magic === 0x4D3C2B1A) this.littleEndian = true;
                     blockLength = view.getUint32(offset + 4, this.littleEndian);
                } else {
                     blockLength = view.getUint32(offset + 4, this.littleEndian);
                }
                
                if (this.buffer.length - offset < blockLength) break;
                
                if (blockType === 0x00000006) { // Enhanced Packet Block (EPB)
                    const interfaceId = view.getUint32(offset + 8, this.littleEndian);
                    const tsHigh = view.getUint32(offset + 12, this.littleEndian);
                    const tsLow = view.getUint32(offset + 16, this.littleEndian);
                    const capturedLen = view.getUint32(offset + 20, this.littleEndian);
                    const origLen = view.getUint32(offset + 24, this.littleEndian);
                    
                    const packetData = this.buffer.subarray(offset + 28, offset + 28 + capturedLen);
                    
                    // TODO: The timestamp unit relies on the timestamp_resolution option inside the Interface Description Block (IDB).
                    // Without tracking IDBs, assuming microsecond precision default mapping.
                    const tsBig = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
                    const tsSec = Number(tsBig / 1000000n);
                    const tsUsec = Number(tsBig % 1000000n);

                    // TODO: Map to actual Interface via IDB list (defaulting to Ethernet 1)
                    const pcapngLinkType = this.interfaces[interfaceId] || 1; 

                    this._processPacketData(packetData, tsSec, tsUsec, origLen, pcapngLinkType);
                } else if (blockType === 0x00000001) { // Interface Description Block (IDB)
                    const linkType = view.getUint16(offset + 8, this.littleEndian);
                    // Add explicitly to tracked interfaces array implicitly incrementing Interface ID
                    this.interfaces.push(linkType);
                }
                
                offset += blockLength;
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
        if (linkType === 1) { // Ethernet II
            if (buffer.length < 14) return;
            // Dest MAC (6), Src MAC (6)
            ethResult.dstMac = this._mac(buffer.subarray(0, 6));
            ethResult.srcMac = this._mac(buffer.subarray(6, 12));
            
            pOffset = 12;
            ethResult.type = view.getUint16(pOffset, false);
            pOffset += 2;
            
            // VLAN tagging (802.1Q)
            if (ethResult.type === 0x8100) {
                if (buffer.length < 18) return;
                pOffset += 2; // skip TCI
                ethResult.type = view.getUint16(pOffset, false);
                pOffset += 2;
            }
        } else if (linkType === 113) { // Linux cooked capture (SLL)
            if (buffer.length < 16) return;
            const packetType = view.getUint16(0, false);
            // packetType 0 = unicast to us, 4 = sent by us
            ethResult.direction = packetType === 0 ? 'in' : (packetType === 4 ? 'out' : 'unknown');
            ethResult.type = view.getUint16(14, false); // Protocol follows explicitly
            pOffset = 16;
        } else {
            // Unsupported link type, skip packet for now
            return;
        }

        let ipResult = null;
        if (ethResult.type === 0x0800) { // IPv4
            if (buffer.length - pOffset < 20) return;
            const b = view.getUint8(pOffset);
            const ihl = (b & 0x0F) * 4; // IP Header length in bytes
            
            ipResult = {
                version: 4,
                srcIP: this._ipv4(buffer.subarray(pOffset + 12, pOffset + 16)),
                dstIP: this._ipv4(buffer.subarray(pOffset + 16, pOffset + 20)),
                protocol: view.getUint8(pOffset + 9), // Protocol (6=TCP, 17=UDP)
                totalLen: view.getUint16(pOffset + 2, false)
            };
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
            pOffset += 40;
            // Note: Does not currently traverse IPv6 extension headers, assuming direct Protocol follows.
        }

        if (!ipResult) return; // Not an IP packet we monitor

        let transportResult = null;
        let payload = null;

        if (ipResult.protocol === 6) { // TCP
            if (buffer.length - pOffset < 20) return;
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
            payload = buffer.subarray(pOffset); // Whatever remains is segment payload
        } else if (ipResult.protocol === 17) { // UDP
            if (buffer.length - pOffset < 8) return;
            transportResult = {
                type: 'UDP',
                srcPort: view.getUint16(pOffset, false),
                dstPort: view.getUint16(pOffset + 2, false),
                len: view.getUint16(pOffset + 4, false)
            };
            
            pOffset += 8;
            payload = buffer.subarray(pOffset, pOffset + transportResult.len - 8); 
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
