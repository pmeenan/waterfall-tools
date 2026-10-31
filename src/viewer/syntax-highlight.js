/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// src/viewer/syntax-highlight.js
//
// Lightweight, dependency-free syntax highlighting for the viewer's request /
// summary panes. Every language is handled by a SINGLE-PASS tokenizer: one
// combined regex (alternation) is run over the *raw* text, every token and
// every gap between tokens is HTML-escaped individually, and markup is only
// ever emitted around already-escaped text. Sequential `replace()` passes over
// previously-highlighted output (the old approach) corrupt the span markup
// they inserted — e.g. a JS string regex matching the `"` inside
// `<span class="hl-keyword">` — so never chain regex passes over HTML here.
//
// Output is only safe for element *content* (it's always placed inside
// <pre>/<td>), never for attribute values.

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

/**
 * Escapes a value for safe insertion as HTML text or a quoted attribute value.
 * `undefined` / `null` render as an empty string.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function span(cls, text) {
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Runs `re` (must be global and must never match the empty string) over
 * `text`, escaping the gaps and delegating each match to `render`, which must
 * return already-escaped HTML.
 */
function tokenize(text, re, render) {
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        out += render(m);
        last = m.index + m[0].length;
    }
    if (last < text.length) out += escapeHtml(text.slice(last));
    return out;
}

// JSON: string (optionally followed by `:` → key), boolean, null, number.
const JSON_TOKEN_RE = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(text) {
    return tokenize(text, JSON_TOKEN_RE, (m) => {
        if (m[1] !== undefined) {
            return m[2] !== undefined ? span('hl-key', m[1] + m[2]) : span('hl-string', m[1]);
        }
        if (m[3] !== undefined) return span('hl-boolean', m[3]);
        if (m[4] !== undefined) return span('hl-null', m[4]);
        return span('hl-number', m[5]);
    });
}

// JS: comments first (so quotes/keywords inside them are inert), then string
// literals (so keywords inside strings are inert), then keywords.
const JS_TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|class|import|export|true|false|null)\b/g;

function highlightJs(text) {
    return tokenize(text, JS_TOKEN_RE, (m) => {
        if (m[1] !== undefined) return span('hl-comment', m[1]);
        if (m[2] !== undefined) return span('hl-string', m[2]);
        return span('hl-keyword', m[3]);
    });
}

// HTML/XML/SVG: a complete start/end tag with its attribute list. Attribute
// alternatives are disjoint on their first character, so the scan stays
// linear. Tag fragments (e.g. a streamed chunk that ends mid-tag) simply
// don't match and are emitted as escaped plain text.
const HTML_TAG_RE = /(<\/?[a-zA-Z][a-zA-Z0-9:._-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)(\s*\/?>)/g;
const HTML_ATTR_RE = /([^\s"'<>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'<>]+))?/g;

function highlightHtml(text) {
    return tokenize(text, HTML_TAG_RE, (m) => {
        const attrs = m[2] ? tokenize(m[2], HTML_ATTR_RE, (a) => {
            let out = span('hl-attr', a[1]);
            if (a[2] !== undefined) out += escapeHtml(a[2]) + span('hl-string', a[3]);
            return out;
        }) : '';
        return span('hl-tag', m[1]) + attrs + span('hl-tag', m[3]);
    });
}

// CSS: `property: value;` declarations. The value can't cross a block brace,
// so selectors like `a:hover { … }` aren't mistaken for declarations.
const CSS_DECL_RE = /([a-zA-Z-][a-zA-Z0-9-]*)(\s*:)([^;{}]+)(;)/g;

function highlightCss(text) {
    return tokenize(text, CSS_DECL_RE, (m) => span('hl-attr', m[1]) + escapeHtml(m[2]) + span('hl-string', m[3]) + escapeHtml(m[4]));
}

/**
 * Returns HTML-escaped `code` with `<span class="hl-*">` markup for the
 * requested language. Unknown languages (including `'text'`) are escaped only.
 * @param {*} code
 * @param {'json'|'js'|'html'|'css'|'text'|string} lang
 * @returns {string}
 */
export function highlightSyntax(code, lang) {
    if (code === undefined || code === null) return '';
    const text = String(code);
    switch (lang) {
        case 'json': return highlightJson(text);
        case 'js': return highlightJs(text);
        case 'html': return highlightHtml(text);
        case 'css': return highlightCss(text);
        default: return escapeHtml(text);
    }
}
