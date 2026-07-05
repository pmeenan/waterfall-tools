/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { isPrivateIPv6 } from '../cloudflare-worker/worker.js';

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
