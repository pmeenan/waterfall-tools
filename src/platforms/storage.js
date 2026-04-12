/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import * as Impl from 'platform-storage-impl';

export async function createStorage(hash) {
    const StorageClass = Impl.NodeStorage || Impl.BrowserStorage;
    const storage = new StorageClass(hash);
    await storage.init();
    return storage;
}

export async function cleanupOrphans() {
    if (Impl.BrowserStorage) {
        await Impl.BrowserStorage.cleanupOrphans();
    }
}
