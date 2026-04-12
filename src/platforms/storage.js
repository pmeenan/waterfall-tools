/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export async function createStorage(hash) {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
        const { BrowserStorage } = await import('./browser/storage-browser.js');
        const storage = new BrowserStorage(hash);
        await storage.init();
        return storage;
    } else {
        const { NodeStorage } = await import('./node/storage-node.js');
        const storage = new NodeStorage(hash);
        await storage.init();
        return storage;
    }
}

export async function cleanupOrphans() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
        const { BrowserStorage } = await import('./browser/storage-browser.js');
        await BrowserStorage.cleanupOrphans();
    }
}
