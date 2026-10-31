/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// File: src/platforms/browser/storage-browser.js

export class NativeStorage {
    constructor(hash) {
        this.hash = hash;
        this.dirHandle = null;
        this.fileHandle = null;
        this._lockResolver = null;
        this._lockPromise = null;
    }

    async init() {
        if (!navigator.storage || !navigator.storage.getDirectory) {
            throw new Error("OPFS is not supported in this browser.");
        }
        // Acquire the shared Web Lock BEFORE creating the OPFS file and wait until the
        // lock callback has actually started (assigning `_lockResolver`) before returning.
        // This prevents both:
        //   (1) `cleanupOrphans()` racing to delete a newly created file before its shared
        //       lock is granted; and
        //   (2) `destroy()` running before `_lockResolver` is assigned and leaking the lock.
        if (navigator.locks) {
            await new Promise((resolveLockAcquired, rejectLockAcquired) => {
                this._lockPromise = navigator.locks.request(`waterfall_opfs_${this.hash}`, { mode: 'shared' }, () => {
                    return new Promise(resolveRelease => {
                        this._lockResolver = resolveRelease;
                        resolveLockAcquired();
                    });
                });
                this._lockPromise.catch(rejectLockAcquired);
            });
        }
        try {
            this.dirHandle = await navigator.storage.getDirectory();
            this.fileHandle = await this.dirHandle.getFileHandle(this.hash, { create: true });
        } catch (err) {
            if (this._lockResolver) {
                const release = this._lockResolver;
                this._lockResolver = null;
                release();
            }
            throw err;
        }
    }

    async writeStream(stream) {
        // Native WritableStream to OPFS
        const writable = await this.fileHandle.createWritable();
        await stream.pipeTo(writable);
    }

    async writeBuffer(buffer) {
        const writable = await this.fileHandle.createWritable();
        await writable.write(buffer);
        await writable.close();
    }

    async read(offset, length) {
        const file = await this.fileHandle.getFile();
        const slice = file.slice(offset, offset + length);
        return new Uint8Array(await slice.arrayBuffer());
    }

    async getSize() {
        const file = await this.fileHandle.getFile();
        return file.size;
    }

    async destroy() {
        if (this.dirHandle && this.hash) {
            try {
                await this.dirHandle.removeEntry(this.hash);
            } catch {
                // Entry may already have been removed or never created
            }
        }
        this.fileHandle = null;
        if (this._lockResolver) {
            const release = this._lockResolver;
            this._lockResolver = null;
            release(); // Release lock
        }
        if (this._lockPromise) {
            await this._lockPromise.catch(() => {});
            this._lockPromise = null;
        }
    }

    static async cleanupOrphans() {
        if (!navigator.storage || !navigator.storage.getDirectory || !navigator.locks) return;
        try {
            const dirHandle = await navigator.storage.getDirectory();
            for await (const [name, handle] of dirHandle.entries()) {
                if (handle.kind === 'file') {
                    // Request exclusive lock. If available, it means no tabs are currently holding the shared lock!
                    await navigator.locks.request(`waterfall_opfs_${name}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
                        if (lock) {
                            try {
                                await dirHandle.removeEntry(name);
                            } catch {}
                        }
                    });
                }
            }
        } catch (e) {
            console.warn("OPFS strictly failed cleanup", e);
        }
    }
}
