/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// src/viewer/embed-api.js
//
// The viewer's postMessage load API: how a page that embeds the viewer in an iframe hands it a
// result to show without publishing it anywhere. Open to any embedder by design — the viewer
// already loads arbitrary input by URL or dropped file — so there is no origin allowlist.
// What keeps it safe instead:
//   - only the frame's own parent may load into it (not other frames or windows that obtained a
//     reference to it);
//   - every payload is untrusted input to the same parsers a dropped file goes through;
//   - replies go to the sender's exact origin, never '*' (except for an opaque 'null' origin,
//     which cannot be targeted), and carry only the request id and a fixed status code — never
//     file names, contents, or parser messages, which could echo user data back.
//
// Protocol 1 (all messages are plain objects):
//   viewer  -> parent  { type: 'waterfall-tools:ready',  protocol: 1 }
//   parent  -> viewer  { type: 'waterfall-tools:load',   protocol: 1, requestId: string,
//                        files: [{ name: string, data: ArrayBuffer }] }
//   viewer  -> sender  { type: 'waterfall-tools:loaded', protocol: 1, requestId }
//   viewer  -> sender  { type: 'waterfall-tools:error',  protocol: 1, requestId, error: ErrorCode }
// `files` mirrors a multi-file drop: each member is sniffed by content, so the same pairs a drop
// accepts (tcpdump + keylog, several qlog connections) work here. Send `data` as a transferred
// ArrayBuffer to avoid a copy; a typed-array view is accepted and its bytes copied.
// Loads are handled one at a time, in arrival order; each one replaces what the viewer shows.

export const EMBED_PROTOCOL = 1;

export const MESSAGE = Object.freeze({
    ready: 'waterfall-tools:ready',
    load: 'waterfall-tools:load',
    loaded: 'waterfall-tools:loaded',
    error: 'waterfall-tools:error',
});

/** Fixed error codes. Replies never carry free text. */
export const ERROR = Object.freeze({
    invalidMessage: 'invalid-message',
    unsupportedProtocol: 'unsupported-protocol',
    loadFailed: 'load-failed',
});

export const MAX_FILES = 16;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 255;

/**
 * Keep only the last path segment and drop control characters, so a name can only ever be used
 * as a label (the parsers use it for things like qlog connection names), never as a path.
 * @param {unknown} name
 * @param {number} index
 * @returns {string}
 */
export function sanitizeFileName(name, index) {
    if (typeof name !== 'string') return `file-${index + 1}`;
    const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
    return base || `file-${index + 1}`;
}

/**
 * Turn an accepted payload member into an ArrayBuffer holding exactly its bytes.
 * @param {unknown} data
 * @returns {ArrayBuffer | null}
 */
function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        // A view may cover part of a larger buffer; copy just its bytes.
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    }
    return null;
}

/**
 * Validate a `load` message.
 * @param {unknown} msg
 * @returns {{ ok: true, requestId: string, files: { name: string, data: ArrayBuffer }[] }
 *         | { ok: false, requestId: string | null, error: string }}
 */
export function parseLoadMessage(msg) {
    const m = /** @type {Record<string, unknown>} */ (msg);
    const requestId = typeof m?.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= MAX_REQUEST_ID_LENGTH
        ? m.requestId : null;
    if (m?.protocol !== EMBED_PROTOCOL) return { ok: false, requestId, error: ERROR.unsupportedProtocol };
    if (requestId === null) return { ok: false, requestId, error: ERROR.invalidMessage };
    if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES) {
        return { ok: false, requestId, error: ERROR.invalidMessage };
    }
    const files = [];
    for (let i = 0; i < m.files.length; i++) {
        const entry = /** @type {Record<string, unknown>} */ (m.files[i]);
        const data = toArrayBuffer(entry?.data);
        if (!data || data.byteLength === 0) return { ok: false, requestId, error: ERROR.invalidMessage };
        files.push({ name: sanitizeFileName(entry.name, i), data });
    }
    return { ok: true, requestId, files };
}

/**
 * Wire the API to a window.
 * @param {object} deps
 * @param {Window} deps.win the viewer's window
 * @param {(files: File[]) => Promise<boolean>} deps.loadFiles loads files exactly as a drop
 *        would; resolves true when the result is on screen, false when it failed
 * @param {(name: string, data: ArrayBuffer) => File} [deps.makeFile]
 * @returns {{ announceReady: () => void, dispose: () => void }}
 */
export function createEmbedApi({ win, loadFiles, makeFile = (name, data) => new File([data], name) }) {
    const embedded = win.parent && win.parent !== win;
    let queue = Promise.resolve();

    /**
     * @param {MessageEventSource} target
     * @param {string} origin
     * @param {object} payload
     */
    const reply = (target, origin, payload) => {
        // An opaque origin ('null', e.g. a sandboxed embedder) cannot be named as a target. The
        // reply holds nothing but the request id and a status code, so '*' leaks nothing there.
        const targetOrigin = origin && origin !== 'null' ? origin : '*';
        try {
            /** @type {Window} */ (target).postMessage({ protocol: EMBED_PROTOCOL, ...payload }, targetOrigin);
        } catch { /* the embedder went away; nothing to tell */ }
    };

    /** @param {MessageEvent} event */
    const onMessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.type !== MESSAGE.load) return;
        // Only the embedding page may load. Other frames (the viewer's own DevTools/Perfetto/qvis
        // iframes) and windows that merely hold a reference to this one are ignored silently.
        if (!embedded || event.source !== win.parent) return;
        const source = event.source;
        const origin = event.origin;
        const parsed = parseLoadMessage(msg);
        if (!parsed.ok) {
            reply(source, origin, { type: MESSAGE.error, requestId: parsed.requestId, error: parsed.error });
            return;
        }
        queue = queue.then(async () => {
            let ok;
            try {
                ok = await loadFiles(parsed.files.map((f) => makeFile(f.name, f.data)));
            } catch {
                ok = false;
            }
            reply(source, origin, ok
                ? { type: MESSAGE.loaded, requestId: parsed.requestId }
                : { type: MESSAGE.error, requestId: parsed.requestId, error: ERROR.loadFailed });
        });
    };

    win.addEventListener('message', onMessage);
    return {
        announceReady() {
            // Carries no data, so '*' is fine: the parent's origin is not known before it writes.
            if (embedded) win.parent.postMessage({ type: MESSAGE.ready, protocol: EMBED_PROTOCOL }, '*');
        },
        dispose() {
            win.removeEventListener('message', onMessage);
        },
    };
}
