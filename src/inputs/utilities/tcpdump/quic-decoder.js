import { deriveTrafficKeys, generateHeaderProtectionMask, decryptQuicPayload } from './quic-crypto.js';
import { QuicBuffer } from './quic-buffer.js';

// Convert hex string to Uint8Array directly natively
function hexToBytes(hex) {
    let bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
}

export async function decodeQuic(chunks, clientPort, keyLog) {
    let clientCidLength = 0;
    let serverCidLength = 0;
    const streams = [];
    const connQuicParams = { streams: new Map() };

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

    const clientKeys = clientSecretStr ? await deriveTrafficKeys(hexToBytes(clientSecretStr)) : null;
    const serverKeys = serverSecretStr ? await deriveTrafficKeys(hexToBytes(serverSecretStr)) : null;

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
                const mask = await generateHeaderProtectionMask(keys.hp, sample);

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
                const aadHeader = new Uint8Array(headerLength);
                aadHeader.set(qb.buffer.subarray(0, headerLength));
                aadHeader[0] = unmaskedHeaderByte;
                
                for (let i = 0; i < pnLength; i++) {
                    aadHeader[protectedOffset + i] ^= mask[1 + i]; // Undo mask to store plaintext
                }

                const payloadBuf = qb.buffer.subarray(headerLength); // Ends naturally with 16-byte Auth Tag

                const decrypted = await decryptQuicPayload(keys.key, keys.iv, packetNumber, aadHeader, payloadBuf);

                if (decrypted) {
                    const qBuffer = new QuicBuffer(decrypted);
                    while (qBuffer.remaining > 0) {
                        const frameType = qBuffer.readVarInt();
                        if (frameType === null) break;

                        if (frameType === 0x00) {
                            // PADDING
                            continue;
                        } else if (frameType === 0x01) {
                            // PING
                            continue;
                        } else if (frameType === 0x02 || frameType === 0x03) {
                            // ACK
                            qBuffer.readVarInt(); // Largest Ack
                            qBuffer.readVarInt(); // Delay
                            const rangeCount = qBuffer.readVarInt();
                            qBuffer.readVarInt(); // First Range
                            if (rangeCount !== null) {
                                for (let i = 0; i < rangeCount; i++) {
                                    qBuffer.readVarInt(); // Gap
                                    qBuffer.readVarInt(); // Range Length
                                }
                            }
                            if (frameType === 0x03) {
                                qBuffer.readVarInt(); qBuffer.readVarInt(); qBuffer.readVarInt(); // ECN
                            }
                        } else if (frameType === 0x04) {
                            // RESET_STREAM
                            qBuffer.readVarInt(); qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x05) {
                            // STOP_SENDING
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x06) {
                            // CRYPTO
                            qBuffer.readVarInt(); // Offset
                            const cLen = qBuffer.readVarInt();
                            if (cLen !== null) qBuffer.readBytes(cLen);
                        } else if (frameType >= 0x08 && frameType <= 0x0f) {
                            // STREAM
                            const offBit = (frameType & 0x04) !== 0;
                            const lenBit = (frameType & 0x02) !== 0;
                            const finBit = (frameType & 0x01) !== 0;

                            const streamId = qBuffer.readVarInt();
                            const offset = offBit ? qBuffer.readVarInt() : 0;
                            const length = lenBit ? qBuffer.readVarInt() : qBuffer.remaining;

                            if (streamId !== null && length !== null) {
                                const data = qBuffer.readBytes(length);
                                if (data) {
                                    if (!connQuicParams.streams.has(streamId)) {
                                        connQuicParams.streams.set(streamId, []);
                                    }
                                    connQuicParams.streams.get(streamId).push({
                                        time: chunk.time,
                                        offset: Number(offset),
                                        data,
                                        fin: finBit,
                                        isClient
                                    });
                                }
                            }
                        } else if (frameType === 0x11) {
                            // STREAM_DATA_BLOCKED
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x12 || frameType === 0x13) {
                            // STREAMS_BLOCKED
                            qBuffer.readVarInt();
                        } else if (frameType === 0x14) {
                            // NEW_CONNECTION_ID
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                            const len = qBuffer.readUInt8();
                            qBuffer.readBytes(len + 16); // Connection ID + Stateless Reset Token
                        } else if (frameType === 0x15) {
                            // RETIRE_CONNECTION_ID
                            qBuffer.readVarInt();
                        } else if (frameType === 0x16 || frameType === 0x17) {
                            // PATH_CHALLENGE / PATH_RESPONSE
                            qBuffer.readBytes(8);
                        } else if (frameType === 0x18 || frameType === 0x19) {
                            // CONNECTION_CLOSE
                            qBuffer.readVarInt();
                            if (frameType === 0x18) qBuffer.readVarInt(); // frame type
                            const rLen = qBuffer.readVarInt();
                            if (rLen !== null) qBuffer.readBytes(rLen);
                        } else if (frameType === 0x1a) {
                            // HANDSHAKE_DONE
                            // 0 bytes payload
                        } else if (frameType === 0x1c || frameType === 0x1d) {
                            // ACK_FREQUENCY (draft extension typically mapped)
                            qBuffer.readVarInt(); qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x0b) {
                            // MAX_DATA
                            qBuffer.readVarInt();
                        } else if (frameType === 0x0c || frameType === 0x0d) {
                            // MAX_STREAM_DATA
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x0e || frameType === 0x0f) {
                            // MAX_STREAMS
                            qBuffer.readVarInt();
                        } else if (frameType === 0x10) {
                            // DATA_BLOCKED
                            qBuffer.readVarInt();
                        } else {
                            // Unknown Frame Type, aborting rest of packet to prevent misalignment
                            // No need to continuously log warning across unknown frames uniformly
                            break;
                        }
                    }

                    streams.push({ time: chunk.time, type: '1-RTT', packetNumber, decryptedLength: decrypted.length });
                } else {
                    streams.push({ time: chunk.time, type: '1-RTT', error: 'AEAD Failed' });
                }
            }
        } catch (e) {
            // Unparsable packet fragment
        }
    }

    return { summaries: streams, params: connQuicParams };
}
