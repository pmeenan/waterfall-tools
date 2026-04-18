// src/viewer/history.js
const DB_NAME = 'WaterfallHistoryDB';
const STORE_NAME = 'historyStore';
const DB_VERSION = 1;

function getDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                // We might want an index on lastAccessed for sorting later
                store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
            }
        };
    });
}

/**
 * Saves a test history record to IndexedDB.
 * @param {Object} params
 * @param {string} params.url - The original URL that was loaded
 * @param {string} params.type - The loaded format type (e.g. 'tcpdump', 'wptagent', 'har')
 * @param {string} params.title - Associated title for the test data
 * @param {string} params.comment - Optional comment
 * @param {string} params.testUrl - The URL of the first page in the data
 * @param {number} params.numPages - The number of pages in the resulting data
 */
export async function saveToHistory({ url, type, title = '', comment = '', testUrl = '', numPages = 0 }) {
    if (!url) return;
    
    // Ensure we don't save arbitrary relative paths if they aren't meant to be tracked
    // Though for now, we'll store whatever URL is passed.
    
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(url);
        
        getReq.onsuccess = () => {
            const data = getReq.result;
            const now = Date.now();
            if (data) {
                data.lastAccessed = now;
                if (type && type !== 'unknown') data.type = type;
                if (title && !data.title) data.title = title;
                if (comment && !data.comment) data.comment = comment;
                if (testUrl && !data.testUrl) data.testUrl = testUrl;
                if (numPages > 0) data.numPages = numPages;
                store.put(data);
            } else {
                store.put({
                    url,
                    firstLoaded: now,
                    lastAccessed: now,
                    type: type || 'unknown',
                    title: title || '',
                    comment: comment || '',
                    testUrl: testUrl || '',
                    numPages: numPages || 0
                });
            }
        };
        
        getReq.onerror = () => reject(getReq.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Retrieves all history records from IndexedDB.
 * @returns {Promise<Array>} List of all history objects
 */
export async function getAllHistory() {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.getAll();
        
        getReq.onsuccess = () => resolve(getReq.result || []);
        getReq.onerror = () => reject(getReq.error);
    });
}

/**
 * Retrieves a single history record.
 * @param {string} url - The URL to look up
 * @returns {Promise<Object|null>}
 */
export async function getHistory(url) {
    if (!url) return null;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(url);
        
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => reject(getReq.error);
    });
}

/**
 * Updates specific fields on an existing history record.
 * @param {string} url - Original URL as ID
 * @param {Object} dataUpdates - Key/value pairs to merge
 */
export async function updateHistoryInfo(url, dataUpdates) {
    if (!url) return;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(url);
        
        getReq.onsuccess = () => {
             const data = getReq.result;
             if (data) {
                 const newData = Object.assign({}, data, dataUpdates);
                 store.put(newData);
                 resolve(newData);
             } else {
                 reject(new Error("Record not found for update"));
             }
        };
        getReq.onerror = () => reject(getReq.error);
    });
}

/**
 * Deletes a history record by URL.
 * @param {string} url - The URL to delete
 */
export async function deleteHistory(url) {
    if (!url) return;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const req = store.delete(url);
        
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Deletes all history records from the store.
 */
export async function clearAllHistory() {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const req = store.clear();
        
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}
