import { deriveTrafficKeys, generateHeaderProtectionMask, decryptQuicPayload } from './quic-crypto.js';
import { QuicBuffer } from './quic-buffer.js';

// Convert hex string to Uint8Array directly natively
function hexToBytes(hex) {
    let bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
}

export async function decodeQuic(chunks, clientPort, keyLog, options = {}) {
    let clientCidLength = 0;
    let serverCidLength = 0;
    // Track CID establishment per-direction since client and server CID lengths can differ.
    // Client→Server packets carry the server's CID; Server→Client carry the client's CID.
    let clientCidEstablished = false;
    let serverCidEstablished = false;
    const streams = [];
    const connQuicParams = { streams: new Map() };

    let keyPairs = [];
    if (keyLog && keyLog.keys) {
        for (const [key, value] of keyLog.keys.entries()) {
            const clientLabel = value['QUIC_CLIENT_TRAFFIC_SECRET_0'] ? 'QUIC_CLIENT_TRAFFIC_SECRET_0' : (value['CLIENT_TRAFFIC_SECRET_0'] ? 'CLIENT_TRAFFIC_SECRET_0' : null);
            const serverLabel = value['QUIC_SERVER_TRAFFIC_SECRET_0'] ? 'QUIC_SERVER_TRAFFIC_SECRET_0' : (value['SERVER_TRAFFIC_SECRET_0'] ? 'SERVER_TRAFFIC_SECRET_0' : null);
            const earlyLabel = value['QUIC_CLIENT_EARLY_TRAFFIC_SECRET'] ? 'QUIC_CLIENT_EARLY_TRAFFIC_SECRET' : (value['CLIENT_EARLY_TRAFFIC_SECRET'] ? 'CLIENT_EARLY_TRAFFIC_SECRET' : null);

            if (clientLabel && serverLabel) {
                 keyPairs.push({ 
                     earlySecretBytes: earlyLabel ? value[earlyLabel] : null,
                     clientSecretBytes: value[clientLabel],
                     serverSecretBytes: value[serverLabel]
                 });
            }
        }
    }

    let derivedKeyPairs = [];
    for (const kp of keyPairs) {
        try {
            const earlyKeys = kp.earlySecretBytes ? await deriveTrafficKeys(kp.earlySecretBytes) : null;
            const clientKeys = await deriveTrafficKeys(kp.clientSecretBytes);
            const serverKeys = await deriveTrafficKeys(kp.serverSecretBytes);
            derivedKeyPairs.push({ earlyKeys, clientKeys, serverKeys });
        } catch (e) {
            if (globalThis.waterfallDebug) console.error("WebCrypto Key Derivation Error: ", e);
            break;
        }
    }
    if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] Valid Key Pairs extracted: ${keyPairs.length}. Derived Key Pairs constructed: ${derivedKeyPairs.length}`);

    let forwardKeys = null;
    let reverseKeys = null;
    let baselineIsClient = null;
    let forwardIsClient = null;

    async function attemptUnmask(keys, firstByte, sample, protectedOffset, fullBuffer) {
        if (!keys) return null;
        try {
            const mask = await generateHeaderProtectionMask(keys.hp, sample);
            const isLongHeader = (firstByte & 0x80) !== 0;
            const unmaskedHeaderByte = firstByte ^ (mask[0] & (isLongHeader ? 0x0F : 0x1F));
            const pnLength = (unmaskedHeaderByte & 0x03) + 1;
            
            let packetNumber = 0;
            for (let i = 0; i < pnLength; i++) {
                const pnByte = fullBuffer[protectedOffset + i] ^ mask[1 + i];
                packetNumber = (packetNumber << 8) | pnByte;
            }
            const headerLength = protectedOffset + pnLength;
            const aadHeader = new Uint8Array(headerLength);
            aadHeader.set(fullBuffer.subarray(0, headerLength));
            aadHeader[0] = unmaskedHeaderByte;
            for (let i = 0; i < pnLength; i++) {
                aadHeader[protectedOffset + i] ^= mask[1 + i];
            }
            const payloadBuf = fullBuffer.slice(headerLength);
            return { packetNumber, aadHeader, payloadBuf };
        } catch (e) {
            if (globalThis.waterfallDebug) console.error("DECODE ERROR", e);
            return null;
        }
    }

    // Track consecutive decryption failures. If we fail on the first N packets
    // without any successful decryption, this isn't a QUIC connection we can
    // decode (likely STUN/TURN/DTLS WebRTC traffic that happens to have bit 6
    // set). Bail out early to avoid brute-forcing all key × CID combinations
    // on thousands of non-QUIC UDP connections.
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;

    for (const chunk of chunks) {
        // Bail out of the entire connection if too many consecutive packets
        // failed decryption — this isn't a QUIC connection we can decode.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;

        const chunkBytes = chunk.bytes;
        const isClient = chunk.isClient;
        let chunkOffset = 0;

        while (chunkOffset < chunkBytes.length) {
            try {
                const firstByte = chunkBytes[chunkOffset];

                // RFC 9000 Section 17: Fixed Bit (0x40) must be 1. Note: STUN packets have 0x00.
                if ((firstByte & 0x40) === 0) {
                    break; // Not a QUIC packet or a version we support, discard rest of UDP payload
                }
                
                const isLongHeader = (firstByte & 0x80) !== 0;

                let packetLength = chunkBytes.length - chunkOffset; // Default for Short Header
                let qbSlice = null;

                if (isLongHeader) {
                    const tempQb = new QuicBuffer(chunkBytes);
                    tempQb.offset = chunkOffset + 5; // Skip Type and Version
                    const dcidLen = tempQb.readUInt8();
                    tempQb.readBytes(dcidLen); // Skip DCID
                    const scidLen = tempQb.readUInt8();
                    tempQb.readBytes(scidLen); // Skip SCID
                    const headerForm = (firstByte & 0x30) >> 4;
                    if (headerForm === 0x00) { // Initial
                        const tokenLen = tempQb.readVarInt();
                        if (tokenLen !== null && tokenLen > 0) tempQb.readBytes(tokenLen);
                    }
                    if (headerForm === 0x00 || headerForm === 0x02 || headerForm === 0x01) {
                        const payloadLen = tempQb.readVarInt();
                        if (payloadLen !== null) {
                             packetLength = (tempQb.offset - chunkOffset) + payloadLen;
                        } else {
                             packetLength = chunkBytes.length - chunkOffset; // Malformed Length, assume remainder
                        }
                    }
                }

                if (chunkOffset + packetLength > chunkBytes.length) {
                    packetLength = chunkBytes.length - chunkOffset; // Truncated gracefully
                }
                
                qbSlice = chunkBytes.subarray(chunkOffset, chunkOffset + packetLength);
                chunkOffset += packetLength; // Advance outer parser to next coalesced packet

                const qb = new QuicBuffer(qbSlice);
                
                if (isLongHeader) {
                    const headerForm = (firstByte & 0x30) >> 4;
                    qb.offset = 5; // Skip Type and Version

                    const dcidLen = qb.readUInt8();
                    qb.readBytes(dcidLen); // Skip DCID
                    const scidLen = qb.readUInt8();
                    qb.readBytes(scidLen); // Skip SCID

                    if (isClient) {
                        clientCidLength = scidLen;
                        clientCidEstablished = true;
                        // Always trust server's own scidLen over client's temporary dcidLen
                        if (!serverCidEstablished) {
                            serverCidLength = dcidLen;
                            serverCidEstablished = true;
                        }
                    } else {
                        serverCidLength = scidLen;
                        serverCidEstablished = true;
                        clientCidLength = dcidLen;
                        clientCidEstablished = true;
                    }

                    if (headerForm === 0x00) { // Initial
                        const tokenLen = qb.readVarInt();
                        if (tokenLen !== null && tokenLen > 0) qb.readBytes(tokenLen);
                    }

                    if (headerForm === 0x00 || headerForm === 0x02 || headerForm === 0x01) {
                        const payloadLen = qb.readVarInt();
                        if (payloadLen === null) continue;
                        
                        if (headerForm === 0x01) { // 0-RTT
                            const protectedOffset = qb.offset;
                            const sampleOffset = protectedOffset + 4;
                            if (sampleOffset + 16 > qb.buffer.length) continue;
                            
                            const sample = qb.buffer.slice(sampleOffset, sampleOffset + 16);
                            let decrypted = null;
                            
                            if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] Found 0-RTT Packet! Length: ${qb.buffer.length}, Sample Offset: ${sampleOffset}`);
                            for (const kp of derivedKeyPairs) {
                                if (!kp.earlyKeys) {
                                     continue;
                                }
                                const unmasked = await attemptUnmask(kp.earlyKeys, firstByte, sample, protectedOffset, qb.buffer);
                                if (unmasked) {
                                    decrypted = await decryptQuicPayload(kp.earlyKeys.key, kp.earlyKeys.iv, unmasked.packetNumber, unmasked.aadHeader, unmasked.payloadBuf);
                                    if (decrypted) {
                                         if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] DECRYPTED 0-RTT SUCCESSFULLY with earlyKeys!`);
                                         break;
                                    } else {
                                         if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] 0-RTT UNMASKED but AEAD MAC FAILED!`);
                                    }
                                }
                            }
                            
                            if (decrypted) {
                                const decQb = new QuicBuffer(decrypted);
                                while (decQb.remaining > 0) {
                                    const frameType = decQb.readVarInt();
                                    if (frameType === null) break;
                                    
                                    if (frameType >= 0x08 && frameType <= 0x0f) {
                                        const offBit = (frameType & 0x04) !== 0;
                                        const lenBit = (frameType & 0x02) !== 0;
                                        const finBit = (frameType & 0x01) !== 0;

                                        const streamId = decQb.readVarInt();
                                        const offset = offBit ? decQb.readVarInt() : 0;
                                        const length = lenBit ? decQb.readVarInt() : decQb.remaining;

                                        if (streamId !== null && length !== null) {
                                            const data = decQb.readBytes(length);
                                            if (data) {
                                                if (!connQuicParams.streams.has(streamId)) {
                                                    connQuicParams.streams.set(streamId, []);
                                                }
                                                connQuicParams.streams.get(streamId).push({
                                                    time: chunk.time,
                                                    offset: Number(offset),
                                                    data,
                                                    fin: finBit,
                                                    isClient: true
                                                });
                                            }
                                        }
                                    } else {
                                        // Skip unknown frames
                                        break; 
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // Short Header (1-RTT)
                    // Client→Server packets carry the server's DCID; Server→Client carry the client's.
                    // When CID length is known for this direction, use it directly.
                    // Otherwise (capture missed Initial/Handshake), probe common CID lengths.
                    const cidKnownForDir = isClient ? serverCidEstablished : clientCidEstablished;
                    const candidateDcidLens = cidKnownForDir
                        ? [isClient ? serverCidLength : clientCidLength]
                        : [0, 8, 4, 16, 20, 1, 2, 3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19];

                let decrypted = null;

                for (const tryDcidLen of candidateDcidLens) {
                    qb.offset = 1;
                    const dcid = qb.readBytes(tryDcidLen);
                    if (!dcid) continue;

                    const protectedOffset = qb.offset;
                    const sampleOffset = protectedOffset + 4;
                    if (sampleOffset + 16 > qb.buffer.length) continue;

                    const sample = qb.buffer.slice(sampleOffset, sampleOffset + 16);

                    if (forwardKeys) {
                        const keys = (chunk.isClient === baselineIsClient) ? forwardKeys : reverseKeys;
                        const unmasked = await attemptUnmask(keys, firstByte, sample, protectedOffset, qb.buffer);
                        if (unmasked) {
                            decrypted = await decryptQuicPayload(keys.key, keys.iv, unmasked.packetNumber, unmasked.aadHeader, unmasked.payloadBuf);
                        }
                    } else {
                        for (const kp of derivedKeyPairs) {
                            // Try clientKeys mapping forward
                            let unmasked = await attemptUnmask(kp.clientKeys, firstByte, sample, protectedOffset, qb.buffer);
                            if (unmasked) {
                                decrypted = await decryptQuicPayload(kp.clientKeys.key, kp.clientKeys.iv, unmasked.packetNumber, unmasked.aadHeader, unmasked.payloadBuf);
                                if (decrypted) {
                                    forwardKeys = kp.clientKeys;
                                    reverseKeys = kp.serverKeys;
                                    baselineIsClient = chunk.isClient;
                                    forwardIsClient = true;
                                    break;
                                } else {
                                    const keyPhase = (firstByte & 0x04) !== 0;
                                    if (chunk.isClient && globalThis.waterfallDebug) console.log("CLIENT KEY UNMASKED 1-RTT BUT MAC FAILED!", { dcidLen: tryDcidLen, pn: unmasked.packetNumber, bufferSliceLength: qb.buffer.length, keyPhase });
                                }
                            }

                            // Try serverKeys mapping forward
                            unmasked = await attemptUnmask(kp.serverKeys, firstByte, sample, protectedOffset, qb.buffer);
                            if (unmasked) {
                                decrypted = await decryptQuicPayload(kp.serverKeys.key, kp.serverKeys.iv, unmasked.packetNumber, unmasked.aadHeader, unmasked.payloadBuf);
                                if (decrypted) {
                                    forwardKeys = kp.serverKeys;
                                    reverseKeys = kp.clientKeys;
                                    baselineIsClient = chunk.isClient;
                                    forwardIsClient = false;
                                    break;
                                } else {
                                    const keyPhase = (firstByte & 0x04) !== 0;
                                    if (!chunk.isClient && globalThis.waterfallDebug) console.log("SERVER KEY UNMASKED 1-RTT BUT MAC FAILED!", { dcidLen: tryDcidLen, pn: unmasked.packetNumber, bufferSliceLength: qb.buffer.length, keyPhase });
                                }
                            }
                        }
                    }

                    if (decrypted) {
                        // Lock in probed CID length for THIS direction only
                        if (!cidKnownForDir) {
                            if (isClient) {
                                serverCidLength = tryDcidLen;
                                serverCidEstablished = true;
                            } else {
                                clientCidLength = tryDcidLen;
                                clientCidEstablished = true;
                            }
                            if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] Probed ${isClient ? 'server' : 'client'} DCID length: ${tryDcidLen} bytes`);
                        }
                        break;
                    }
                }

                if (decrypted) {
                    const usedForwardKeys = (chunk.isClient === baselineIsClient);
                    const activeIsClientAuth = usedForwardKeys ? forwardIsClient : !forwardIsClient;
                    
                    if (!activeIsClientAuth && !connQuicParams.handshakeTime) {
                        connQuicParams.handshakeTime = chunk.time;
                    }
                    
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
                                for (let i = 0; i < rangeCount && qBuffer.remaining > 0; i++) {
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
                        } else if (frameType === 0x07) {
                            // NEW_TOKEN
                            const tLen = qBuffer.readVarInt();
                            if (tLen !== null) qBuffer.readBytes(tLen);
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
                                        isClient: activeIsClientAuth
                                    });
                                }
                            }
                        } else if (frameType === 0x10) {
                            // MAX_DATA
                            qBuffer.readVarInt();
                        } else if (frameType === 0x11) {
                            // MAX_STREAM_DATA
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x12 || frameType === 0x13) {
                            // MAX_STREAMS
                            qBuffer.readVarInt();
                        } else if (frameType === 0x14) {
                            // DATA_BLOCKED
                            qBuffer.readVarInt();
                        } else if (frameType === 0x15) {
                            // STREAM_DATA_BLOCKED
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                        } else if (frameType === 0x16 || frameType === 0x17) {
                            // STREAMS_BLOCKED
                            qBuffer.readVarInt();
                        } else if (frameType === 0x18) {
                            // NEW_CONNECTION_ID
                            qBuffer.readVarInt(); qBuffer.readVarInt();
                            const len = qBuffer.readUInt8();
                            qBuffer.readBytes(len + 16); // Connection ID + Stateless Reset Token
                        } else if (frameType === 0x19) {
                            // RETIRE_CONNECTION_ID
                            qBuffer.readVarInt();
                        } else if (frameType === 0x1a || frameType === 0x1b) {
                            // PATH_CHALLENGE / PATH_RESPONSE
                            qBuffer.readBytes(8);
                        } else if (frameType === 0x1c || frameType === 0x1d) {
                            // CONNECTION_CLOSE
                            qBuffer.readVarInt();
                            if (frameType === 0x1c) qBuffer.readVarInt(); // frame type
                            const rLen = qBuffer.readVarInt();
                            if (rLen !== null) qBuffer.readBytes(rLen);
                        } else if (frameType === 0x1e) {
                            // HANDSHAKE_DONE
                            // 0 bytes payload
                        } else {
                            // Unknown Frame Type, aborting rest of packet to prevent misalignment
                            // No need to continuously log warning across unknown frames uniformly
                            break;
                        }
                    }

                    streams.push({ time: chunk.time, type: '1-RTT', decryptedLength: decrypted.length });
                    consecutiveFailures = 0; // Reset on success
                } else {
                    if (globalThis.waterfallDebug) console.log(`[QUIC Decoder] AEAD Failed mapping 1-RTT for target packet (likely missing key or wrong connection).`);
                    streams.push({ time: chunk.time, type: '1-RTT', error: 'AEAD Failed' });
                    // Only count failures toward the bail-out limit when we have
                    // never established keys. Once keys are found, sporadic failures
                    // are expected (key rotation, padding, reordering) and shouldn't
                    // cause an early abort.
                    if (!forwardKeys) consecutiveFailures++;
                }
            }
        } catch (e) {
            if (globalThis.waterfallDebug) console.error("DECODE ERROR", e);
            break; // Break the while loop if packet is malformed
        }
        }
    }

    return { summaries: streams, params: connQuicParams };
}
