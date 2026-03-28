export class TlsKeyLog {
    constructor() {
        this.keys = new Map();
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
            sessionKeys[label] = Buffer.from(secret, 'hex');
        }
    }

    /**
     * Retrieve all derived secret labels known for a specific Client Random.
     * @param {string|Buffer} clientRandom 
     * @returns {Object|null}
     */
    getSessionKeys(clientRandom) {
        const hex = Buffer.isBuffer(clientRandom) || clientRandom instanceof Uint8Array ? 
                    Buffer.from(clientRandom).toString('hex').toLowerCase() : 
                    clientRandom.toLowerCase();
        return this.keys.get(hex) || null;
    }
}
