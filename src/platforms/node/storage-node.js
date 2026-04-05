// File: src/platforms/node/storage-node.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export class NodeStorage {
    constructor(hash) {
        this.hash = hash;
        this.filePath = path.join(os.tmpdir(), `waterfall_opfs_${hash}`);
        this.fd = null;
    }

    async init() {
    }

    async writeStream(stream) {
        // Pipe the Web ReadableStream to a Node WritableStream 
        const nodeStream = fs.createWriteStream(this.filePath);
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!nodeStream.write(value)) {
                    await new Promise(resolve => nodeStream.once('drain', resolve));
                }
            }
        } finally {
            nodeStream.end();
            await new Promise(resolve => nodeStream.once('finish', resolve));
        }
    }

    async writeBuffer(buffer) {
        await fsp.writeFile(this.filePath, buffer);
    }

    async read(offset, length) {
        if (!this.fd) {
            this.fd = await fsp.open(this.filePath, 'r');
        }
        // Read into Uint8Array (Node natively supports this via Buffer)
        const buf = new Uint8Array(length);
        const { bytesRead } = await this.fd.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    }

    async getSize() {
        const stat = await fsp.stat(this.filePath);
        return stat.size;
    }

    async destroy() {
        if (this.fd) {
            await this.fd.close().catch(() => {});
            this.fd = null;
        }
        try {
            await fsp.unlink(this.filePath);
        } catch (e) {}
    }

    static async cleanupOrphans() {}
}
