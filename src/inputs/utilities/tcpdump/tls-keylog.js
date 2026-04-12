/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class TlsKeyLog {
    constructor() {
        this.keys = new Map();
    }

    _hexToBytes(hex) {
        let bytes = new Uint8Array(Math.ceil(hex.length / 2));
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    _bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Parse the raw contents of a key log file.
     * @param {string} contents 
     */
    parseString(contents) {
        const lines = contents.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;

            const parts = line.split(' ');
            if (parts.length < 3) continue;

            const label = parts[0];
            const clientRandom = parts[1].toLowerCase();
            const secret = parts[2].toLowerCase();

            let sessionKeys = this.keys.get(clientRandom);
            if (!sessionKeys) {
                sessionKeys = {};
                this.keys.set(clientRandom, sessionKeys);
            }
            sessionKeys[label] = this._hexToBytes(secret);
        }
    }

    /**
     * Retrieve all derived secret labels known for a specific Client Random.
     * @param {string|Buffer} clientRandom 
     * @returns {Object|null}
     */
    getSessionKeys(clientRandom) {
        const hex = clientRandom instanceof Uint8Array ? 
                    this._bytesToHex(clientRandom).toLowerCase() : 
                    clientRandom.toLowerCase();
        return this.keys.get(hex) || null;
    }
}
