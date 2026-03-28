import crypto from 'node:crypto';
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
            { isEncrypted: false, key: null, iv: null, sequence: 0n, trafficSecret: null },
            { isEncrypted: false, key: null, iv: null, sequence: 0n, trafficSecret: null }
        ];

        this.buffers = [Buffer.alloc(0), Buffer.alloc(0)];
        this.decryptedStream = [[], []]; // Chunks of decrypted ApplicationData
    }

    push(direction, chunkBuffer, timestamp) {
        // Concatenate new data to any existing partial data in the buffer
        let b = this.buffers[direction];
        this.buffers[direction] = Buffer.concat([b, Buffer.from(chunkBuffer)]);
        
        this._parseRecords(direction, timestamp);
    }

    getDecryptedChunks(direction) {
        return this.decryptedStream[direction];
    }

    _parseRecords(direction, timestamp) {
        let buf = this.buffers[direction];

        // Ensure we have at least the TLS record header (5 bytes)
        while (buf.length >= 5) {
            const type = buf.readUInt8(0);
            const ver = buf.readUInt16BE(1);
            const length = buf.readUInt16BE(3);

            if (buf.length < 5 + length) {
                // Not enough data for the full record yet. Break to wait for more TCP chunks.
                break; 
            }

            const recordFragment = buf.subarray(5, 5 + length);
            
            // Advance the buffer immediately
            buf = buf.subarray(5 + length);
            this.buffers[direction] = buf;

            this._processRecord(direction, type, ver, recordFragment, timestamp);
        }
    }

    _processRecord(direction, type, ver, fragment, timestamp) {
        const state = this.cryptoState[direction];

        // 20 = ChangeCipherSpec
        if (type === 20) {
            state.isEncrypted = true;
            return;
        }

        if (state.isEncrypted) {
            // Decrypt the fragment. In TLS 1.3, Handshake traffic is encrypted here. 
            // In TLS 1.2, early ApplicationData is encrypted.
            if (!state.key || !state.iv) return; // Cannot decrypt without keys
            
            this._decryptFragment(direction, type, ver, fragment, timestamp);
        } else {
            // Unencrypted records
            if (type === 22) { // Handshake
                this._parseHandshake(direction, fragment);
            }
        }
    }

    _parseHandshake(direction, fragment) {
        let offset = 0;
        while (offset + 4 <= fragment.length) {
            const handType = fragment.readUInt8(offset);
            const length = (fragment.readUInt8(offset + 1) << 16) | (fragment.readUInt8(offset + 2) << 8) | fragment.readUInt8(offset + 3);
            offset += 4;

            if (offset + length > fragment.length) break; // Truncated handshake

            const msg = fragment.subarray(offset, offset + length);
            offset += length;

            if (handType === 1) { // ClientHello
                if (msg.length >= 34) {
                    this.clientRandom = msg.subarray(2, 34); // Skip 2 bytes of Version
                }
            } else if (handType === 2) { // ServerHello
                if (msg.length >= 34) {
                    this.serverRandom = msg.subarray(2, 34); // Skip 2 bytes of Version
                    
                    let sessLen = msg.readUInt8(34);
                    let cipherOffset = 34 + 1 + sessLen;
                    
                    if (cipherOffset + 2 <= msg.length) {
                        this.cipherSuiteId = msg.readUInt16BE(cipherOffset);
                        this.cipherSuite = CIPHER_SUITES[this.cipherSuiteId];
                        
                        if (this.cipherSuite && this.cipherSuite.tls13) {
                            this.isTls13 = true;
                        }

                        this._deriveKeys(false);
                    }
                }
            } else if (handType === 20) { // Finished
                // In TLS 1.3, Handshake Finished means the NEXT messages in this direction will use Application Traffic Secrets.
                if (this.isTls13) {
                    this.cryptoState[direction].phase = 'application';
                    this._deriveTls13KeysForDirection(direction, this.keyLog.getSessionKeys(this.clientRandom));
                    // Reset sequence number to 0 when keys change in TLS 1.3
                    this.cryptoState[direction].sequence = 0n;
                }
            }
        }
    }

    _deriveKeys(isApplicationPhase = false) {
        if (!this.clientRandom || !this.cipherSuite || !this.keyLog) return;
        
        const keyMaterial = this.keyLog.getSessionKeys(this.clientRandom);
        if (!keyMaterial) {
            console.log(`[TLS] No key material found for ClientRandom: ${this.clientRandom.toString('hex')}`);
            return;
        }

        console.log(`[TLS] Key material found! Deriving keys... Phase Application? ${isApplicationPhase}`);
        if (this.isTls13) {
            this._deriveTls13KeysForDirection(0, keyMaterial);
            this._deriveTls13KeysForDirection(1, keyMaterial);
        } else {
            this._deriveTls12Keys(keyMaterial);
        }
    }

    _deriveTls13KeysForDirection(dir, keyMaterial) {
        if (!keyMaterial) return;
        const phase = this.cryptoState[dir].phase || 'handshake';
        
        let clientSecretStr = phase === 'application' ? 'CLIENT_TRAFFIC_SECRET_0' : 'CLIENT_HANDSHAKE_TRAFFIC_SECRET';
        let serverSecretStr = phase === 'application' ? 'SERVER_TRAFFIC_SECRET_0' : 'SERVER_HANDSHAKE_TRAFFIC_SECRET';

        const secretStr = dir === 0 ? clientSecretStr : serverSecretStr;
        const secret = keyMaterial[secretStr];
        
        if (!secret) return; 

        this.cryptoState[dir].trafficSecret = secret;

        const alg = this.cipherSuite.hashAlg;

        this.cryptoState[dir].key = hkdfExpandLabel(secret, "key", Buffer.alloc(0), alg, this.cipherSuite.keyLen);
        this.cryptoState[dir].iv = hkdfExpandLabel(secret, "iv", Buffer.alloc(0), alg, this.cipherSuite.ivLen);
        
        console.log(`[TLS 1.3] Dir ${dir} Phase ${phase} derived. Secret: ${secret.toString('hex').substring(0, 16)}... Key(${this.cryptoState[dir].key.length}b), IV(${this.cryptoState[dir].iv.length}b)`);
    }

    _deriveTls12Keys(keyMaterial) {
        const masterSecret = keyMaterial['CLIENT_RANDOM'];
        if (!masterSecret || !this.serverRandom) return;

        // TLS 1.2 Key Expansion: PRF(master_secret, "key expansion", server_random + client_random)
        const seed = Buffer.concat([this.serverRandom, this.clientRandom]);
        
        // Needed: 2 * (mac_key_length + enc_key_length + fixed_iv_length)
        // Assuming AEAD (GCM/Poly1305), mac_key_length = 0
        const encLen = this.cipherSuite.keyLen;
        const ivLen = this.cipherSuite.fixedIvLen;
        const totalLen = 2 * (encLen + ivLen);
        
        const alg = this.cipherSuite.hashAlg;
        const keyBlock = prfTls12(masterSecret, "key expansion", seed, alg, totalLen);

        let offset = 0;
        // MAC keys are omitted for AEAD ciphers in TLS 1.2
        this.cryptoState[0].key = keyBlock.subarray(offset, offset + encLen); offset += encLen;
        this.cryptoState[1].key = keyBlock.subarray(offset, offset + encLen); offset += encLen;
        this.cryptoState[0].iv = keyBlock.subarray(offset, offset + ivLen); offset += ivLen;
        this.cryptoState[1].iv = keyBlock.subarray(offset, offset + ivLen); offset += ivLen;

        console.log(`[TLS 1.2] Derived keys from MS. BlockLen: ${totalLen}, Key0(${this.cryptoState[0].key.length}b), IV0(${this.cryptoState[0].iv.length}b)`);
    }

    _decryptFragment(direction, recordType, ver, fragment, timestamp) {
        const state = this.cryptoState[direction];
        const alg = this.cipherSuite.alg;
        
        let nonce;
        let ciphertext;
        let authTag;
        let payload;

        try {
            if (this.isTls13 || alg === 'chacha20-poly1305') {
                // TLS 1.3 or ChaCha20 TLS 1.2:
                // Nonce = IV XOR sequence_number (padded)
                const seqBuf = Buffer.alloc(12);
                seqBuf.writeBigUInt64BE(state.sequence, 4);
                
                nonce = Buffer.alloc(12);
                for (let i = 0; i < 12; i++) {
                    nonce[i] = state.iv[i] ^ seqBuf[i];
                }

                ciphertext = fragment.subarray(0, fragment.length - 16);
                authTag = fragment.subarray(fragment.length - 16);

            } else {
                // TLS 1.2 AES-GCM:
                // Nonce = fixed_iv (4 bytes) + explicit_iv (8 bytes)
                const explicitIv = fragment.subarray(0, 8);
                nonce = Buffer.concat([state.iv, explicitIv]);

                ciphertext = fragment.subarray(8, fragment.length - 16);
                authTag = fragment.subarray(fragment.length - 16);
            }

            // Create decipher
            const decipher = crypto.createDecipheriv(alg, state.key, nonce);
            decipher.setAuthTag(authTag);

            // AAD (Additional Authenticated Data)
            // TLS 1.2 requires AAD: seq_num (8) + type (1) + version (2) + length (2)
            // TLS 1.3 requires AAD: outer_type (1) + legacy_version (2) + length (2)
            if (this.isTls13) {
                const aad = Buffer.alloc(5);
                aad.writeUInt8(recordType, 0); // Always 23 for outer TL1.3 records
                aad.writeUInt16BE(ver, 1);  // Legacy version
                aad.writeUInt16BE(fragment.length, 3);
                decipher.setAAD(aad);
            } else {
                const aad = Buffer.alloc(13);
                aad.writeBigUInt64BE(state.sequence, 0);
                aad.writeUInt8(recordType, 8);
                aad.writeUInt16BE(ver, 9); // TLS 1.2 version
                aad.writeUInt16BE(ciphertext.length, 11);
                decipher.setAAD(aad);
            }

            payload = decipher.update(ciphertext);
            payload = Buffer.concat([payload, decipher.final()]);

            // For TLS 1.3, the true type is appended at the end of the plaintext followed by padding zeros
            if (this.isTls13) {
                let end = payload.length - 1;
                while (end >= 0 && payload[end] === 0) {
                    end--;
                }
                const trueType = payload[end];
                payload = payload.subarray(0, end);
                
                const previousPhase = state.phase;
                // If it's handshake stuff nested inside (like ServerCertificate in TLS 1.3)
                if (trueType === 22) {
                    this._parseHandshake(direction, payload); // Process nested handshake
                    if (state.phase === previousPhase) {
                        state.sequence++;
                    }
                    return;
                } else if (trueType !== 23) {
                    // Not application data (maybe alerts)
                    state.sequence++;
                    return; 
                }
            }
            
            // Only output if it's application data
            if (recordType === 23 || (this.isTls13)) {
                if (payload.length > 0) {
                    console.log(`[TLS] Decryption Success! Length: ${payload.length}`);
                    this.decryptedStream[direction].push({
                        time: timestamp,
                        bytes: payload
                    });
                }
            }
            
            state.sequence++;
        } catch (e) {
            // Decryption failure (MAC mismatch, bad keys, missing secrets)
            console.error(`[TLS] Decryption failed parsing sequence ${state.sequence}: ${e.message}`);
            state.sequence++; // Still increment sequence on failure to avoid desync
        }
    }
}
