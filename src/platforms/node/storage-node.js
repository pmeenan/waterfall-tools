/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// File: src/platforms/node/storage-node.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export class NativeStorage {
    constructor(hash) {
        this.hash = hash;
        this.filePath = path.join(os.tmpdir(), `waterfall_opfs_${hash}`);
        this.fd = null;
        this._openPromise = null;
    }

    async init() {
    }

    async writeStream(stream) {
        // Pipe the Web ReadableStream to a Node WritableStream
        const nodeStream = fs.createWriteStream(this.filePath);
        let streamError = null;
        const onError = (err) => {
            if (!streamError) streamError = err;
        };
        nodeStream.on('error', onError);
        const reader = stream.getReader();
        try {
            while (true) {
                if (streamError) throw streamError;
                const { done, value } = await reader.read();
                if (done) break;
                if (streamError) throw streamError;
                if (!nodeStream.write(value)) {
                    await new Promise((resolve, reject) => {
                        if (streamError) return reject(streamError);
                        const onDrain = () => {
                            nodeStream.removeListener('error', onDrainErr);
                            resolve();
                        };
                        const onDrainErr = (err) => {
                            nodeStream.removeListener('drain', onDrain);
                            reject(err);
                        };
                        nodeStream.once('drain', onDrain);
                        nodeStream.once('error', onDrainErr);
                    });
                }
            }
            await new Promise((resolve, reject) => {
                if (streamError) return reject(streamError);
                const onFinish = () => {
                    nodeStream.removeListener('error', onFinishErr);
                    resolve();
                };
                const onFinishErr = (err) => {
                    nodeStream.removeListener('finish', onFinish);
                    reject(err);
                };
                nodeStream.once('finish', onFinish);
                nodeStream.once('error', onFinishErr);
                nodeStream.end();
            });
        } catch (err) {
            nodeStream.destroy();
            throw err;
        } finally {
            try { reader.releaseLock(); } catch {}
        }
    }

    async writeBuffer(buffer) {
        await fsp.writeFile(this.filePath, buffer);
    }

    async read(offset, length) {
        if (!this.fd) {
            if (!this._openPromise) {
                this._openPromise = fsp.open(this.filePath, 'r').then(handle => {
                    this.fd = handle;
                    return handle;
                }).catch(err => {
                    this._openPromise = null;
                    throw err;
                });
            }
            await this._openPromise;
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
        if (this._openPromise && !this.fd) {
            try {
                this.fd = await this._openPromise;
            } catch {}
        }
        this._openPromise = null;
        if (this.fd) {
            await this.fd.close().catch(() => {});
            this.fd = null;
        }
        try {
            await fsp.unlink(this.filePath);
        } catch {}
    }

    static async cleanupOrphans() {}
}
