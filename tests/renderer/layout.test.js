/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { Layout } from '../../src/renderer/layout.js';

describe('Layout.parseUrlFilter', () => {
    it('returns empty includes/excludes for an empty or whitespace-only string', () => {
        expect(Layout.parseUrlFilter('')).toEqual({ includes: [], excludes: [] });
        expect(Layout.parseUrlFilter('   ')).toEqual({ includes: [], excludes: [] });
    });

    it('compiles a bare glob token to an unanchored, case-insensitive regex', () => {
        const { includes } = Layout.parseUrlFilter('*.google.com');
        expect(includes).toHaveLength(1);
        expect(includes[0].source).toBe('.*\\.google\\.com');
        expect(includes[0].flags).toBe('i');
        expect(includes[0].test('www.google.com')).toBe(true);
        expect(includes[0].test('www.GOOGLE.com')).toBe(true);
        expect(includes[0].test('example.com')).toBe(false);
    });

    it('matches a bare substring token anywhere in the hostname (unanchored)', () => {
        const { includes } = Layout.parseUrlFilter('google.com');
        expect(includes[0].test('www.google.com')).toBe(true);
    });

    it('escapes regex metacharacters other than *', () => {
        const { includes } = Layout.parseUrlFilter('cdn.example-1.com');
        // '.' should be escaped literally; '-' is not a regex metacharacter
        // outside a character class, so it's left as-is.
        expect(includes[0].source).toBe('cdn\\.example-1\\.com');
        expect(includes[0].test('cdn.example-1.com')).toBe(true);
        expect(includes[0].test('cdnXexample-1Xcom')).toBe(false);
    });

    it('treats a /.../ delimited token as raw regex source', () => {
        const { includes } = Layout.parseUrlFilter('/^cdn\\d+\\.example\\.com$/');
        expect(includes).toHaveLength(1);
        expect(includes[0].source).toBe('^cdn\\d+\\.example\\.com$');
        expect(includes[0].test('cdn3.example.com')).toBe(true);
        expect(includes[0].test('cdn3.example.com.evil.com')).toBe(false);
    });

    it('routes a leading "-" token to excludes, not includes', () => {
        const { includes, excludes } = Layout.parseUrlFilter('-ads.example.com');
        expect(includes).toHaveLength(0);
        expect(excludes).toHaveLength(1);
        expect(excludes[0].test('ads.example.com')).toBe(true);
    });

    it('drops an invalid regex token silently (neither includes nor excludes)', () => {
        const { includes, excludes } = Layout.parseUrlFilter('/[unbalanced/');
        expect(includes).toHaveLength(0);
        expect(excludes).toHaveLength(0);
    });

    it('splits multiple comma-separated tokens and trims whitespace', () => {
        const { includes, excludes } = Layout.parseUrlFilter(' *.google.com , -ads.example.com , /cdn\\d+\\.example\\.com/ ');
        expect(includes).toHaveLength(2);
        expect(excludes).toHaveLength(1);
        expect(includes[1].test('cdn3.example.com')).toBe(true);
    });

    it('skips empty tokens produced by trailing/duplicate commas', () => {
        const { includes, excludes } = Layout.parseUrlFilter('*.google.com,,');
        expect(includes).toHaveLength(1);
        expect(excludes).toHaveLength(0);
    });

    it('does not split a comma inside a regex quantifier (e.g. {1,3})', () => {
        const { includes } = Layout.parseUrlFilter('/^cdn\\d{1,3}\\.example\\.com$/');
        expect(includes).toHaveLength(1);
        expect(includes[0].source).toBe('^cdn\\d{1,3}\\.example\\.com$');
        expect(includes[0].test('cdn12.example.com')).toBe(true);
        expect(includes[0].test('cdn1234.example.com')).toBe(false);
    });

    it('still splits on the comma that follows a closed regex literal', () => {
        const { includes } = Layout.parseUrlFilter('/^cdn\\d{1,3}\\.example\\.com$/,*.google.com');
        expect(includes).toHaveLength(2);
        expect(includes[0].source).toBe('^cdn\\d{1,3}\\.example\\.com$');
        expect(includes[1].source).toBe('.*\\.google\\.com');
    });
});

describe('Layout.splitFilterTokens', () => {
    it('splits plain comma-separated tokens', () => {
        expect(Layout.splitFilterTokens('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('does not split on a comma inside an open /regex/ literal', () => {
        expect(Layout.splitFilterTokens('/a{1,3}/,b')).toEqual(['/a{1,3}/', 'b']);
    });

    it('treats an escaped slash as a literal character, not a delimiter toggle', () => {
        expect(Layout.splitFilterTokens('/a\\/b,c/,d')).toEqual(['/a\\/b,c/', 'd']);
    });
});

describe('Layout.getFilterHost', () => {
    it('extracts the hostname from a well-formed URL', () => {
        expect(Layout.getFilterHost('https://www.google.com/page?x=1')).toBe('www.google.com');
    });

    it('falls back to the raw string when the URL cannot be parsed', () => {
        expect(Layout.getFilterHost('not a url')).toBe('not a url');
    });

    it('returns an empty string for an empty/undefined url', () => {
        expect(Layout.getFilterHost('')).toBe('');
        expect(Layout.getFilterHost(undefined)).toBe('');
    });
});

describe('Layout.calculateRows urlFilter', () => {
    const makeEntries = (urls) => urls.map((url, i) => ({
        index: i,
        url,
        mimeType: 'text/html',
        status: 200,
        time_start: i * 10,
        time_end: i * 10 + 5,
        timings: { dns: 0, connect: 0, ssl: 0, send: 0, wait: 2, receive: 3 }
    }));

    it('include-only: keeps only requests whose hostname matches at least one include pattern', () => {
        const entries = makeEntries([
            'https://www.google.com/a',
            'https://example.com/b',
            'https://sub.google.com/c'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '*.google.com' });
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.index)).toEqual([0, 2]);
    });

    it('exclude-only: drops requests whose hostname matches any exclude pattern, keeps the rest', () => {
        const entries = makeEntries([
            'https://ads.example.com/banner.png',
            'https://www.example.com/index.html'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '-ads.example.com' });
        expect(rows).toHaveLength(1);
        expect(rows[0].index).toBe(1);
    });

    it('mixed include+exclude: exclude wins even when a hostname also matches an include', () => {
        const entries = makeEntries([
            'https://ads.example.com/tracker.js',
            'https://cdn.example.com/app.js',
            'https://other.com/app.js'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '*.example.com,-ads.example.com' });
        expect(rows.map(r => r.index)).toEqual([1]);
    });

    it('no matches: returns an empty row set without throwing', () => {
        const entries = makeEntries(['https://example.com/a']);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '*.nomatch.test' });
        expect(rows).toHaveLength(0);
    });

    it('does not match on path/query content that is not part of the hostname', () => {
        const entries = makeEntries([
            'https://example.com/redirect?to=https://www.google.com/'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '*.google.com' });
        expect(rows).toHaveLength(0);
    });

    it('connectionView bypasses urlFilter entirely', () => {
        const entries = makeEntries([
            'https://example.com/a',
            'https://other.com/b'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, {
            urlFilter: '*.nomatch.test',
            connectionView: true
        });
        expect(rows.length).toBeGreaterThan(0);
    });

    it('combines with reqFilter via AND', () => {
        const entries = makeEntries([
            'https://www.google.com/a',
            'https://www.google.com/b',
            'https://example.com/c'
        ]);
        const { rows } = Layout.calculateRows(entries, 1000, {
            reqFilter: '1-2',
            urlFilter: '*.google.com'
        });
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.index).sort()).toEqual([0, 1]);
    });

    it('empty urlFilter is a no-op', () => {
        const entries = makeEntries(['https://example.com/a', 'https://other.com/b']);
        const { rows } = Layout.calculateRows(entries, 1000, { urlFilter: '' });
        expect(rows).toHaveLength(2);
    });
});
