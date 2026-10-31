const CACHE_PREFIX = 'waterfall-tools-';
const CACHE_NAME = `${CACHE_PREFIX}v4`;

// All path matching is relative to the service worker's scope so the viewer can be hosted
// under any prefix (including one that itself contains "/waterfall-tools/").
const SCOPE_PATH = new URL(self.registration ? self.registration.scope : './', self.location.href).pathname;

// Immutable, content-addressed assets that are safe to serve cache-first:
//  - Vite viewer assets:            assets/<name>-<hash>.<ext>
//  - Hashed library payload/chunks: waterfall-tools/<name>-<hash>.js (NOT the un-hashed
//                                   waterfall-tools.es.js stub, which must stay network-first)
//  - Versioned embed bundles:       devtools-<version>/..., qvis-<version>/...
const VERSIONED_ASSET_PATTERNS = [
    /^assets\/[^/]+$/,
    /^waterfall-tools\/[\w.-]+-[\w-]{8,}\.js$/,
    /^devtools-[\w.+-]+\//,
    /^qvis-[\w.+-]+\//
];

function offlineResponse() {
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
}

function isCacheableResponse(response) {
    return response && response.status === 200 && response.type === 'basic';
}

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
    // Drop every older waterfall-tools cache generation so stale (and possibly
    // previously-cached proxy) responses can't be served after an upgrade. Caches owned
    // by other apps on the same origin (different prefix) are left alone.
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names
                .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
                .map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // Only handle http/https requests
    if (!request.url.startsWith('http')) return;

    // Bypass the service worker entirely for local development
    const isLocalhost = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
    if (isLocalhost) return;

    const url = new URL(request.url);

    // Never touch cross-origin traffic (remote ?src= loads, Perfetto UI, etc.) — let the
    // browser handle it with normal HTTP semantics.
    if (url.origin !== self.location.origin) return;

    // Only static viewer files inside our scope are cacheable. Anything else — most
    // importantly the same-origin `/fetch?url=` CORS proxy, whose responses are arbitrary
    // user-requested captures — goes straight to the network and is never stored.
    if (!url.pathname.startsWith(SCOPE_PATH)) return;
    const relPath = url.pathname.slice(SCOPE_PATH.length);
    if (relPath === 'fetch' || relPath.startsWith('fetch/') || url.pathname.endsWith('/fetch')) return;
    // Partial-content requests can't be satisfied from (or stored in) the cache correctly.
    if (request.headers.has('range')) return;

    const isVersionedAsset = VERSIONED_ASSET_PATTERNS.some((re) => re.test(relPath));

    if (isVersionedAsset) {
        // Cache-First Strategy strictly for definitively versioned blobs
        event.respondWith(
            caches.match(request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(request).then((networkResponse) => {
                    if (!isCacheableResponse(networkResponse)) {
                        return networkResponse;
                    }
                    const responseClone = networkResponse.clone();
                    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone)));
                    return networkResponse;
                });
            }).catch(() => offlineResponse())
        );
        return;
    }

    // Default Network-First strategy (fallback to cache if offline)
    event.respondWith(
        fetch(request).then((networkResponse) => {
            if (!isCacheableResponse(networkResponse)) {
                return networkResponse;
            }
            const responseClone = networkResponse.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone)));
            return networkResponse;
        }).catch(() => {
            // Network failed, fallback to cache
            return caches.match(request).then((cached) => cached || offlineResponse());
        })
    );
});
