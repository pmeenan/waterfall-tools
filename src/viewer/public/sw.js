const CACHE_NAME = 'waterfall-tools-v1';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                './',
                './index.html',
                './logo.jpg',
                './favicon.ico'
            ]);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    
    // Only handle http/https requests
    if (!event.request.url.startsWith('http')) return;

    const url = new URL(event.request.url);
    const isVersionedAsset = url.pathname.includes('/assets/') || url.pathname.includes('/waterfall-tools/');

    if (isVersionedAsset) {
        // Cache-First Strategy strictly for definitively versioned blobs
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request).then((networkResponse) => {
                    if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                        return networkResponse;
                    }
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
                    return networkResponse;
                }).catch(() => {
                    // Ignore network errors
                });
            })
        );
        return;
    }

    // Default Network-First strategy (fallback to cache if offline)
    event.respondWith(
        fetch(event.request).then((networkResponse) => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                return networkResponse;
            }
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
            });
            return networkResponse;
        }).catch(() => {
            // Network failed, fallback to cache
            return caches.match(event.request);
        })
    );
});
