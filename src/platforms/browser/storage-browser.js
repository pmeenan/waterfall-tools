// File: src/platforms/browser/storage-browser.js

export class BrowserStorage {
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
        this.dirHandle = await navigator.storage.getDirectory();
        this.fileHandle = await this.dirHandle.getFileHandle(this.hash, { create: true });
        
        // Hold a shared lock for the lifetime of this object using Web Locks API
        // This natively solves the multi-tab cleanup coordination.
        if (navigator.locks) {
            this._lockPromise = navigator.locks.request(`waterfall_opfs_${this.hash}`, { mode: 'shared' }, () => {
                return new Promise(resolve => {
                    this._lockResolver = resolve;
                });
            });
            // Don't await the lock cleanly locking in background
            this._lockPromise.catch(() => {});
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
        if (this._lockResolver) {
            this._lockResolver(); // Release lock
            this._lockResolver = null;
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
                            } catch (e) {}
                        }
                    });
                }
            }
        } catch (e) {
            console.warn("OPFS strictly failed cleanup", e);
        }
    }
}
