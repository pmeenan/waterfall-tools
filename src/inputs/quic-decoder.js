import { deriveTrafficKeys, generateHeaderProtectionMask, decryptQuicPayload } from './quic-crypto.js';
import { QuicBuffer } from './quic-buffer.js';
import { decodeHttp3Stream } from './qpack-decoder.js';

export function decodeQuic(chunks, clientPort, keyLog) {
    let clientCidLength = 0;
    let serverCidLength = 0;
    const streams = [];

    let clientSecretStr = null;
    let serverSecretStr = null;

    if (keyLog && keyLog.keys) {
        for (const [key, value] of keyLog.keys.entries()) {
            if (value && value['QUIC_CLIENT_TRAFFIC_SECRET_0']) {
                clientSecretStr = value['QUIC_CLIENT_TRAFFIC_SECRET_0'].toString('hex');
                serverSecretStr = value['QUIC_SERVER_TRAFFIC_SECRET_0'].toString('hex');
                break;
            }
        }
    }

    const clientKeys = clientSecretStr ? deriveTrafficKeys(Buffer.from(clientSecretStr, 'hex')) : null;
    const serverKeys = serverSecretStr ? deriveTrafficKeys(Buffer.from(serverSecretStr, 'hex')) : null;

    for (const chunk of chunks) {
        const qb = new QuicBuffer(chunk.bytes);
        const isClient = chunk.isClient;
        
        try {
            const firstByte = qb.buffer[0];
            const isLongHeader = (firstByte & 0x80) !== 0;

            if (isLongHeader) {
                const headerForm = (firstByte & 0x30) >> 4;
                qb.offset = 5; // Skip Type and Version
                
                const dcidLen = qb.readUInt8();
                qb.readBytes(dcidLen); // Skip DCID
                const scidLen = qb.readUInt8();
                qb.readBytes(scidLen); // Skip SCID
                
                if (isClient && clientCidLength === 0) clientCidLength = scidLen;
                if (!isClient && serverCidLength === 0) serverCidLength = scidLen;

                if (headerForm === 0x00) { // Initial
                    const tokenLen = qb.readVarInt();
                    if (tokenLen !== null && tokenLen > 0) qb.readBytes(tokenLen);
                }

                if (headerForm === 0x00 || headerForm === 0x02 || headerForm === 0x01) { 
                    const payloadLen = qb.readVarInt(); 
                    if (payloadLen === null) continue;
                    // We can attempt Native Header Protection removal here for 'Initial' keys (omitted for brevity)
                    streams.push({ time: chunk.time, type: 'long', length: payloadLen });
                }
            } else {
                // Short Header (1-RTT)
                // Read implicit DCID
                const expectedDcidLen = isClient ? serverCidLength : clientCidLength;
                qb.offset = 1;
                const dcid = qb.readBytes(expectedDcidLen); // Skip DCID
                if (!dcid) continue;

                // The remainder starts with the Header Protection mask and packet number
                const protectedOffset = qb.offset;
                const sampleOffset = protectedOffset + 4; // Assuming maximum 4 byte packet number length for sample mask
                
                if (sampleOffset + 16 > qb.buffer.length) continue; // Too short for AEAD sample mask

                // We need the HP Key mapping
                const keys = isClient ? clientKeys : serverKeys;
                if (!keys) {
                    streams.push({ time: chunk.time, type: 'short', error: 'No Traffic Secret' });
                    continue; // Missing secrets
                }

                const sample = qb.buffer.subarray(sampleOffset, sampleOffset + 16);
                const mask = generateHeaderProtectionMask(keys.hp, sample);
                
                // Unmask the first byte
                const unmaskedHeaderByte = firstByte ^ (mask[0] & 0x1F); // 0x1F mask for short headers
                const pnLength = (unmaskedHeaderByte & 0x03) + 1;
                
                // Unmask the packet number
                let packetNumber = 0;
                for (let i = 0; i < pnLength; i++) {
                    const pnByte = qb.buffer[protectedOffset + i] ^ mask[1 + i];
                    packetNumber = (packetNumber << 8) | pnByte;
                }

                // We have successfully removed Header protection!
                // Extract AEAD payload
                const headerLength = protectedOffset + pnLength;
                
                // Reconstruct the exact unmasked header byte sequence to use as AAD context for AEAD decryption natively
                const aadHeader = Buffer.from(qb.buffer.subarray(0, headerLength));
                aadHeader[0] = unmaskedHeaderByte;
                for (let i = 0; i < pnLength; i++) {
                    aadHeader[protectedOffset + i] ^= mask[1 + i]; // Undo mask to store plaintext
                }

                const payloadBuf = qb.buffer.subarray(headerLength); // Ends naturally with 16-byte Auth Tag

                const decrypted = decryptQuicPayload(keys.key, keys.iv, packetNumber, aadHeader, payloadBuf);
                
                if (decrypted) {
                    // Extract QPACK literals from decrypted frames
                    const http3 = decodeHttp3Stream(decrypted);
                    streams.push({ time: chunk.time, type: '1-RTT', packetNumber, decryptedLength: decrypted.length, http3 });
                } else {
                    streams.push({ time: chunk.time, type: '1-RTT', error: 'AEAD Failed' });
                }
            }
        } catch (e) {
            // Unparsable packet fragment
            console.error(`QUIC parsing error: ${e.message}`);
        }
    }

    return streams;
}
