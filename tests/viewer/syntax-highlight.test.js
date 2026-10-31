/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// The viewer's syntax highlighter must tokenize in a single pass: chained
// regex replacements over already-highlighted output corrupted the inserted
// span markup (e.g. the JS string pass matched the quotes inside
// `<span class="hl-keyword">`). Output must also always be fully escaped.
import { describe, it, expect } from 'vitest';
import { highlightSyntax, escapeHtml } from '../../src/viewer/syntax-highlight.js';

// Strip our own span markup and decode the entities we emit → must equal the input.
const toText = (html) => html
    .replace(/<span class="hl-[a-z]+">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Any `<` left after removing our own spans means raw markup leaked through.
const hasForeignMarkup = (html) => /</.test(html.replace(/<span class="hl-[a-z]+">|<\/span>/g, ''));

describe('escapeHtml', () => {
    it('escapes all HTML-significant characters and renders null/undefined as empty', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('highlightSyntax', () => {
    it('returns empty string for null/undefined', () => {
        expect(highlightSyntax(null, 'js')).toBe('');
        expect(highlightSyntax(undefined, 'json')).toBe('');
    });

    it('js: keywords and strings do not corrupt each other', () => {
        const code = `const s = "if (x) return 'y'"; // let it be\nfunction f() { return \`class\`; }`;
        const html = highlightSyntax(code, 'js');
        expect(toText(html)).toBe(code);
        expect(hasForeignMarkup(html)).toBe(false);
        // The keyword inside the string literal is part of the string token, not a keyword span.
        expect(html).toContain('<span class="hl-string">&quot;if (x) return &#39;y&#39;&quot;</span>');
        expect(html).toContain('<span class="hl-keyword">const</span>');
        expect(html).toContain('<span class="hl-comment">// let it be</span>');
        // No nested spans anywhere.
        expect(html).not.toMatch(/<span class="hl-[a-z]+">[^<]*<span/);
    });

    it('js: hostile code cannot inject markup', () => {
        const code = `var x = "</span><img src=x onerror=alert(1)>"; '<script>'`;
        const html = highlightSyntax(code, 'js');
        expect(hasForeignMarkup(html)).toBe(false);
        expect(toText(html)).toBe(code);
    });

    it('json: classifies keys, strings, numbers, booleans and null', () => {
        const code = '{"a": "b<c>", "n": -1.5e3, "t": true, "z": null}';
        const html = highlightSyntax(code, 'json');
        expect(toText(html)).toBe(code);
        expect(hasForeignMarkup(html)).toBe(false);
        expect(html).toContain('<span class="hl-key">&quot;a&quot;:</span>');
        expect(html).toContain('<span class="hl-string">&quot;b&lt;c&gt;&quot;</span>');
        expect(html).toContain('<span class="hl-number">-1.5e3</span>');
        expect(html).toContain('<span class="hl-boolean">true</span>');
        expect(html).toContain('<span class="hl-null">null</span>');
    });

    it('html: highlights tags/attributes and keeps text + partial tags escaped', () => {
        const code = '<div class="a" data-x=\'1\' hidden>Tom & "Jerry"</div><img src=x onerror=alert(1)';
        const html = highlightSyntax(code, 'html');
        expect(toText(html)).toBe(code);
        expect(hasForeignMarkup(html)).toBe(false);
        expect(html).toContain('<span class="hl-tag">&lt;div</span>');
        expect(html).toContain('<span class="hl-attr">class</span>=<span class="hl-string">&quot;a&quot;</span>');
        expect(html).toContain('<span class="hl-attr">hidden</span>');
    });

    it('css: declarations do not split HTML entities or span blocks', () => {
        const code = 'a:hover { content: "<b>"; color: red; }';
        const html = highlightSyntax(code, 'css');
        expect(toText(html)).toBe(code);
        expect(hasForeignMarkup(html)).toBe(false);
        expect(html).toContain('<span class="hl-attr">content</span>:<span class="hl-string"> &quot;&lt;b&gt;&quot;</span>;');
        expect(html).toContain('<span class="hl-attr">color</span>:<span class="hl-string"> red</span>;');
    });

    it('text / unknown languages are escaped only', () => {
        expect(highlightSyntax('<b>"x"</b>', 'text')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
        expect(highlightSyntax(42, 'other')).toBe('42');
    });

    it('stays fast on large unterminated input (no catastrophic backtracking)', () => {
        const big = '<a href="' + 'x'.repeat(20000) + ' `' + "'".repeat(5000) + '/*' + ' class'.repeat(5000);
        const t0 = Date.now();
        for (const lang of ['js', 'json', 'html', 'css']) {
            expect(toText(highlightSyntax(big, lang))).toBe(big);
        }
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});
