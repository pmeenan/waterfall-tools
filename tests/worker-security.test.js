/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isPrivateIPv6, isPrivateHost } from '../cloudflare-worker/worker.js';

describe('Cloudflare Worker SSRF IPv6 guard', () => {
    it('blocks private IPv6 ranges and normalized IPv4-mapped loopback forms', () => {
        expect(isPrivateIPv6('::1')).toBe(true);
        expect(isPrivateIPv6('::')).toBe(true);
        expect(isPrivateIPv6('fc00::1')).toBe(true);
        expect(isPrivateIPv6('fd12::1')).toBe(true);
        expect(isPrivateIPv6('fe80::1')).toBe(true);
        expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
        expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true);
        expect(isPrivateIPv6('::127.0.0.1')).toBe(true);
        expect(isPrivateIPv6('::7f00:1')).toBe(true);
        expect(isPrivateIPv6('64:ff9b::808:808')).toBe(true);
        expect(isPrivateIPv6('100::1')).toBe(true);
    });

    it('allows ordinary public IPv6 addresses', () => {
        expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
        expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
    });
});

describe('Cloudflare Worker SSRF defense-in-depth', () => {
    it('blocks 6to4 addresses embedding private IPv4 and all Teredo addresses', () => {
        expect(isPrivateIPv6('2002:7f00:1::1')).toBe(true);       // 6to4 → 127.0.0.1
        expect(isPrivateIPv6('2002:c0a8:101::1')).toBe(true);     // 6to4 → 192.168.1.1
        expect(isPrivateIPv6('2002:0808:0808::1')).toBe(false);   // 6to4 → 8.8.8.8
        expect(isPrivateIPv6('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true); // Teredo
        expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false); // not Teredo
    });

    it('strips the DNS root trailing dot before hostname checks', () => {
        expect(isPrivateHost('localhost.')).toBe(true);
        expect(isPrivateHost('metadata.google.internal.')).toBe(true);
        expect(isPrivateHost('printer.local.')).toBe(true);
        expect(isPrivateHost('.')).toBe(true);
        expect(isPrivateHost('example.com.')).toBe(false);
    });
});

describe('Cloudflare Worker /fetch request handling', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const HAR_BYTES = new TextEncoder().encode('{"log":{"version":"1.2","creator":{"name":"t","version":"0"},"pages":[],"entries":[]}}');

    function dohResponse(url) {
        const type = new URL(url).searchParams.get('type');
        const answer = type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [];
        return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { 'Content-Type': 'application/dns-json' } });
    }

    function proxyRequest(ip, target = 'https://example.com/test.har') {
        return new Request(`https://proxy.example/fetch?url=${encodeURIComponent(target)}`, {
            headers: { 'CF-Connecting-IP': ip }
        });
    }

    it('cancels the upstream body on non-2xx responses', async () => {
        let cancelled = false;
        vi.stubGlobal('fetch', async (url) => {
            if (String(url).startsWith('https://cloudflare-dns.com/')) return dohResponse(String(url));
            const body = new ReadableStream({
                pull(controller) { controller.enqueue(new Uint8Array(16)); },
                cancel() { cancelled = true; }
            });
            return new Response(body, { status: 404 });
        });
        const res = await worker.fetch(proxyRequest('198.51.100.10'));
        expect(res.status).toBe(502);
        expect(cancelled).toBe(true);
    });

    it('cancels the upstream body when Content-Length exceeds the cap', async () => {
        let cancelled = false;
        vi.stubGlobal('fetch', async (url) => {
            if (String(url).startsWith('https://cloudflare-dns.com/')) return dohResponse(String(url));
            const body = new ReadableStream({
                pull(controller) { controller.enqueue(new Uint8Array(16)); },
                cancel() { cancelled = true; }
            });
            return new Response(body, { status: 200, headers: { 'Content-Length': String(500 * 1024 * 1024) } });
        });
        const res = await worker.fetch(proxyRequest('198.51.100.11'));
        expect(res.status).toBe(413);
        expect(cancelled).toBe(true);
    });

    it('counts attempts at request start so concurrent in-flight requests are limited', async () => {
        const pending = [];
        vi.stubGlobal('fetch', (url) => {
            if (String(url).startsWith('https://cloudflare-dns.com/')) return Promise.resolve(dohResponse(String(url)));
            // Upstream never answers until released — every request stays in flight.
            return new Promise((resolve) => pending.push(() => resolve(new Response(HAR_BYTES, { status: 200 }))));
        });
        const ip = '198.51.100.12';
        const inflight = [];
        for (let i = 0; i < 100; i++) inflight.push(worker.fetch(proxyRequest(ip)));
        const limited = await worker.fetch(proxyRequest(ip));
        expect(limited.status).toBe(429);

        // Release everything and make sure the in-flight requests complete normally.
        await vi.waitFor(() => expect(pending.length).toBe(100));
        pending.forEach(release => release());
        const results = await Promise.all(inflight);
        expect(results.every(r => r.status === 200)).toBe(true);
        await Promise.all(results.map(r => r.arrayBuffer()));
    });
});
