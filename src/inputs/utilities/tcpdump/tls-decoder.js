/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { hkdfExpandLabel, prfTls12 } from './tls-crypto.js';

export const CIPHER_SUITES = {
    // TLS 1.2
    0xC02F: { name: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', alg: 'aes-128-gcm', keyLen: 16, ivLen: 4, fixedIvLen: 4, recordIvLen: 8, hashAlg: 'sha256', tls13: false },
    0xC030: { name: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', alg: 'aes-256-gcm', keyLen: 32, ivLen: 4, fixedIvLen: 4, recordIvLen: 8, hashAlg: 'sha384', tls13: false },
    0xC02B: { name: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', alg: 'aes-128-gcm', keyLen: 16, ivLen: 4, fixedIvLen: 4, recordIvLen: 8, hashAlg: 'sha256', tls13: false },
    0xC02C: { name: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', alg: 'aes-256-gcm', keyLen: 32, ivLen: 4, fixedIvLen: 4, recordIvLen: 8, hashAlg: 'sha384', tls13: false },
    0xCCA8: { name: 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256', alg: 'chacha20-poly1305', keyLen: 32, ivLen: 12, hashAlg: 'sha256', tls13: false },
    0xCCA9: { name: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', alg: 'chacha20-poly1305', keyLen: 32, ivLen: 12, hashAlg: 'sha256', tls13: false },

    // TLS 1.3
    0x1301: { name: 'TLS_AES_128_GCM_SHA256', alg: 'aes-128-gcm', keyLen: 16, ivLen: 12, hashAlg: 'sha256', tls13: true },
    0x1302: { name: 'TLS_AES_256_GCM_SHA384', alg: 'aes-256-gcm', keyLen: 32, ivLen: 12, hashAlg: 'sha384', tls13: true },
    0x1303: { name: 'TLS_CHACHA20_POLY1305_SHA256', alg: 'chacha20-poly1305', keyLen: 32, ivLen: 12, hashAlg: 'sha256', tls13: true }
};

function concatUint8Arrays(arrays) {
    const len = arrays.reduce((acc, a) => acc + a.length, 0);
    const result = new Uint8Array(len);
    let offset = 0;
    for (const a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}

export class TlsDecoder {
    constructor(keyLog) {
        this.keyLog = keyLog;

        this.clientRandom = null;
        this.serverRandom = null;
        this.cipherSuiteId = null;
        this.cipherSuite = null;
        this.isTls13 = false;
        
        // Key material per direction: 0 = Client->Server, 1 = Server->Client
        this.cryptoState = [
            { isEncrypted: false, key: null, iv: null, sequence: 0n, trafficSecret: null, rawKey: null },
            { isEncrypted: false, key: null, iv: null, sequence: 0n, trafficSecret: null, rawKey: null }
        ];

        this.buffers = [new Uint8Array(0), new Uint8Array(0)];
        this.decryptedStream = [[], []]; // Chunks of decrypted ApplicationData
    }

    async push(direction, chunkBuffer, timestamp) {
        // Concatenate new data to any existing partial data in the buffer
        const b = this.buffers[direction];
        this.buffers[direction] = concatUint8Arrays([b, chunkBuffer instanceof Uint8Array ? chunkBuffer : new Uint8Array(chunkBuffer)]);
        
        await this._parseRecords(direction, timestamp);
    }

    getDecryptedChunks(direction) {
        return this.decryptedStream[direction];
    }

    async _parseRecords(direction, timestamp) {
        let buf = this.buffers[direction];

        while (buf.length >= 5) {
            const type = buf[0];
            const ver = (buf[1] << 8) | buf[2];
            const length = (buf[3] << 8) | buf[4];

            if (buf.length < 5 + length) break; 

            const recordFragment = buf.subarray(5, 5 + length);
            buf = buf.subarray(5 + length);
            this.buffers[direction] = buf;

            await this._processRecord(direction, type, ver, recordFragment, timestamp);
        }
    }

    async _processRecord(direction, type, ver, fragment, timestamp) {
        const state = this.cryptoState[direction];

        if (type === 20) { // ChangeCipherSpec
            state.isEncrypted = true;
            return;
        }

        if (state.isEncrypted) {
            if (!state.key || !state.iv) return; 
            await this._decryptFragment(direction, type, ver, fragment, timestamp);
        } else {
            if (type === 22) { // Handshake
                await this._parseHandshake(direction, fragment);
            }
        }
    }

    async _parseHandshake(direction, fragment) {
        let offset = 0;
        while (offset + 4 <= fragment.length) {
            const handType = fragment[offset];
            const length = (fragment[offset + 1] << 16) | (fragment[offset + 2] << 8) | fragment[offset + 3];
            offset += 4;

            if (offset + length > fragment.length) break; 

            const msg = fragment.subarray(offset, offset + length);
            offset += length;

            if (handType === 1) { // ClientHello
                if (msg.length >= 34) {
                    this.clientRandom = msg.subarray(2, 34); 
                }
            } else if (handType === 2) { // ServerHello
                if (msg.length >= 34) {
                    this.serverRandom = msg.subarray(2, 34); 
                    
                    const sessLen = msg[34];
                    const cipherOffset = 34 + 1 + sessLen;
                    
                    if (cipherOffset + 2 <= msg.length) {
                        this.cipherSuiteId = (msg[cipherOffset] << 8) | msg[cipherOffset + 1];
                        this.cipherSuite = CIPHER_SUITES[this.cipherSuiteId];
                        
                        if (this.cipherSuite && this.cipherSuite.tls13) {
                            this.isTls13 = true;
                        }

                        await this._deriveKeys(false);
                    }
                }
            } else if (handType === 20) { // Finished
                if (this.isTls13) {
                    this.cryptoState[direction].phase = 'application';
                    try {
                        await this._deriveTls13KeysForDirection(direction, this.keyLog.getSessionKeys(this.clientRandom));
                        this.cryptoState[direction].sequence = 0n;
                    } catch {}
                }
            }
        }
    }

    async _deriveKeys(_isApplicationPhase = false) {
        if (!this.clientRandom || !this.cipherSuite || !this.keyLog) return;
        
        const keyMaterial = this.keyLog.getSessionKeys(this.clientRandom);
        if (!keyMaterial) return;

        try {
            if (this.isTls13) {
                await this._deriveTls13KeysForDirection(0, keyMaterial);
                await this._deriveTls13KeysForDirection(1, keyMaterial);
            } else {
                await this._deriveTls12Keys(keyMaterial);
            }
        } catch {
            // WebCrypto unavailable
        }
    }

    async _deriveTls13KeysForDirection(dir, keyMaterial) {
        if (!keyMaterial) return;
        const phase = this.cryptoState[dir].phase || 'handshake';
        
        const clientSecretStr = phase === 'application' ? 'CLIENT_TRAFFIC_SECRET_0' : 'CLIENT_HANDSHAKE_TRAFFIC_SECRET';
        const serverSecretStr = phase === 'application' ? 'SERVER_TRAFFIC_SECRET_0' : 'SERVER_HANDSHAKE_TRAFFIC_SECRET';

        const secretStr = dir === 0 ? clientSecretStr : serverSecretStr;
        const secret = keyMaterial[secretStr];
        
        if (!secret) return; 

        this.cryptoState[dir].trafficSecret = secret;
        const alg = this.cipherSuite.hashAlg;

        // Ensure key derivation runs gracefully mapping to array representations natively securely
        const secretArray = new Uint8Array(secret);
        
        this.cryptoState[dir].key = await hkdfExpandLabel(secretArray, "key", new Uint8Array(0), alg, this.cipherSuite.keyLen);
        this.cryptoState[dir].iv = await hkdfExpandLabel(secretArray, "iv", new Uint8Array(0), alg, this.cipherSuite.ivLen);
        this.cryptoState[dir].rawKey = null; // Clear cached WebCrypto key
    }

    async _deriveTls12Keys(keyMaterial) {
        const masterSecret = keyMaterial['CLIENT_RANDOM'];
        if (!masterSecret || !this.serverRandom) return;

        const masterSecretArray = new Uint8Array(masterSecret);
        const seed = concatUint8Arrays([new Uint8Array(this.serverRandom), new Uint8Array(this.clientRandom)]);
        
        const encLen = this.cipherSuite.keyLen;
        const ivLen = this.cipherSuite.fixedIvLen;
        const totalLen = 2 * (encLen + ivLen);
        
        const alg = this.cipherSuite.hashAlg;
        const keyBlock = await prfTls12(masterSecretArray, "key expansion", seed, alg, totalLen);

        let offset = 0;
        this.cryptoState[0].key = keyBlock.subarray(offset, offset + encLen); offset += encLen;
        this.cryptoState[1].key = keyBlock.subarray(offset, offset + encLen); offset += encLen;
        this.cryptoState[0].iv = keyBlock.subarray(offset, offset + ivLen); offset += ivLen;
        this.cryptoState[1].iv = keyBlock.subarray(offset, offset + ivLen);

        this.cryptoState[0].rawKey = null;
        this.cryptoState[1].rawKey = null;
    }

    async _decryptFragment(direction, recordType, ver, fragment, timestamp) {
        const state = this.cryptoState[direction];
        const alg = this.cipherSuite.alg;
        
        let nonce;
        let payloadBuffer;
        let aad;

        try {
            if (this.isTls13 || alg === 'chacha20-poly1305') {
                const seqArray = new Uint8Array(12);
                let seq = state.sequence;
                for (let i = 11; i >= 4; i--) {
                    seqArray[i] = Number(seq & 0xFFn);
                    seq >>= 8n;
                }
                
                nonce = new Uint8Array(12);
                for (let i = 0; i < 12; i++) {
                    nonce[i] = state.iv[i] ^ seqArray[i];
                }

                payloadBuffer = fragment.subarray(0, fragment.length); 

                if (this.isTls13) {
                    aad = new Uint8Array(5);
                    aad[0] = recordType; 
                    aad[1] = (ver >> 8) & 0xff;
                    aad[2] = ver & 0xff;
                    aad[3] = (fragment.length >> 8) & 0xff;
                    aad[4] = fragment.length & 0xff;
                }
            } else {
                const explicitIv = fragment.subarray(0, 8);
                nonce = concatUint8Arrays([state.iv, explicitIv]);
                payloadBuffer = fragment.subarray(8, fragment.length); 
                
                aad = new Uint8Array(13);
                let seq = state.sequence;
                for (let i = 7; i >= 0; i--) {
                    aad[i] = Number(seq & 0xFFn);
                    seq >>= 8n;
                }
                aad[8] = recordType;
                aad[9] = (ver >> 8) & 0xff;
                aad[10] = ver & 0xff;
                aad[11] = ((payloadBuffer.length - 16) >> 8) & 0xff; // length without tag
                aad[12] = (payloadBuffer.length - 16) & 0xff;
            }

            let webAlgName;
            if (alg === 'aes-128-gcm' || alg === 'aes-256-gcm') {
                webAlgName = 'AES-GCM';
            } else if (alg === 'chacha20-poly1305') {
                webAlgName = 'CHACHA20-POLY1305'; // Will throw unsupported in Chrome natively via best-effort handling seamlessly
            } else {
                return;
            }

            if (!state.rawKey) {
                state.rawKey = await globalThis.crypto.subtle.importKey(
                    'raw',
                    state.key,
                    { name: webAlgName },
                    false,
                    ['decrypt']
                );
            }

            const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
                {
                    name: webAlgName,
                    iv: nonce,
                    additionalData: aad,
                    tagLength: 128
                },
                state.rawKey,
                payloadBuffer
            );
            
            let payload = new Uint8Array(decryptedBuffer);

            if (this.isTls13) {
                let end = payload.length - 1;
                while (end >= 0 && payload[end] === 0) end--;
                
                const trueType = payload[end];
                payload = payload.subarray(0, end);
                
                const previousPhase = state.phase;
                if (trueType === 22) {
                    await this._parseHandshake(direction, payload);
                    if (state.phase === previousPhase) {
                        state.sequence++;
                    }
                    return;
                } else if (trueType !== 23) {
                    state.sequence++;
                    return; 
                }
            }
            
            if (recordType === 23 || this.isTls13) {
                if (payload.length > 0) {
                    this.decryptedStream[direction].push({
                        time: timestamp,
                        bytes: payload
                    });
                }
            }
            state.sequence++;
        } catch {
            state.sequence++;
        }
    }
}
