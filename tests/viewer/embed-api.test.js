/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// The viewer's postMessage load API (src/viewer/embed-api.js). It is open to any embedder, so the
// tests concentrate on what keeps that safe: only the parent frame may load, replies go to the
// sender's exact origin, and replies never carry anything but the request id and a status code.
import { describe, it, expect, vi } from 'vitest';
import {
    createEmbedApi, parseLoadMessage, sanitizeFileName, EMBED_PROTOCOL, MESSAGE, ERROR, MAX_FILES,
} from '../../src/viewer/embed-api.js';

const bytes = (...b) => new Uint8Array(b).buffer;
const loadMsg = (extra = {}) => ({
    type: MESSAGE.load, protocol: EMBED_PROTOCOL, requestId: 'r1', files: [{ name: 'a.har', data: bytes(1, 2, 3) }], ...extra,
});

/** A viewer window framed by `parent`, with a dispatcher for incoming messages. */
function setup({ loadFiles = vi.fn(async () => true), framed = true } = {}) {
    const parent = { postMessage: vi.fn() };
    const listeners = [];
    const win = {
        addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
        removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    };
    win.parent = framed ? parent : win;
    const makeFile = (name, data) => ({ name, data });
    const api = createEmbedApi({ win, loadFiles, makeFile });
    const send = (data, { source = parent, origin = 'https://embedder.example' } = {}) => {
        for (const fn of [...listeners]) fn({ data, source, origin });
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { api, parent, send, settle, loadFiles, listeners };
}

describe('embed API: messages', () => {
    it('announces ready to the parent, with no data', () => {
        const { api, parent } = setup();
        api.announceReady();
        expect(parent.postMessage).toHaveBeenCalledWith({ type: MESSAGE.ready, protocol: EMBED_PROTOCOL }, '*');
    });

    it('stays silent when the viewer is not framed', () => {
        const { api, parent, send, loadFiles } = setup({ framed: false });
        api.announceReady();
        send(loadMsg());
        expect(parent.postMessage).not.toHaveBeenCalled();
        expect(loadFiles).not.toHaveBeenCalled();
    });

    it('loads posted files and replies loaded to the sender origin', async () => {
        const { parent, send, settle, loadFiles } = setup();
        send(loadMsg());
        await settle();
        expect(loadFiles).toHaveBeenCalledTimes(1);
        expect(loadFiles.mock.calls[0][0]).toEqual([{ name: 'a.har', data: bytes(1, 2, 3) }]);
        expect(parent.postMessage).toHaveBeenCalledWith(
            { protocol: EMBED_PROTOCOL, type: MESSAGE.loaded, requestId: 'r1' }, 'https://embedder.example');
    });

    it('replies a bare load-failed code when the load fails or throws', async () => {
        for (const loadFiles of [vi.fn(async () => false), vi.fn(async () => { throw new Error('secret cookie=abc'); })]) {
            const { parent, send, settle } = setup({ loadFiles });
            send(loadMsg());
            await settle();
            const [reply, origin] = parent.postMessage.mock.calls[0];
            expect(reply).toEqual({ protocol: EMBED_PROTOCOL, type: MESSAGE.error, requestId: 'r1', error: ERROR.loadFailed });
            expect(JSON.stringify(reply)).not.toContain('secret');
            expect(origin).toBe('https://embedder.example');
        }
    });

    it('ignores loads from anything but the parent frame', async () => {
        const { parent, send, settle, loadFiles } = setup();
        const otherFrame = { postMessage: vi.fn() };
        send(loadMsg(), { source: otherFrame });
        send(loadMsg(), { source: null });
        await settle();
        expect(loadFiles).not.toHaveBeenCalled();
        expect(parent.postMessage).not.toHaveBeenCalled();
        expect(otherFrame.postMessage).not.toHaveBeenCalled();
    });

    it('ignores messages that are not load requests', async () => {
        const { parent, send, settle, loadFiles } = setup();
        for (const data of [null, 'string', 42, {}, { type: 'qvis-ready' }, { type: MESSAGE.loaded }]) send(data);
        await settle();
        expect(loadFiles).not.toHaveBeenCalled();
        expect(parent.postMessage).not.toHaveBeenCalled();
    });

    it('replies to an opaque origin with *, since null cannot be targeted', async () => {
        const { parent, send, settle } = setup();
        send(loadMsg(), { origin: 'null' });
        await settle();
        expect(parent.postMessage.mock.calls[0][1]).toBe('*');
    });

    it('handles loads one at a time, in order', async () => {
        const order = [];
        let release;
        const gate = new Promise((r) => { release = r; });
        const loadFiles = vi.fn(async (files) => {
            order.push(`start ${files[0].name}`);
            if (files[0].name === 'first') await gate;
            order.push(`end ${files[0].name}`);
            return true;
        });
        const { send, settle } = setup({ loadFiles });
        send(loadMsg({ requestId: 'a', files: [{ name: 'first', data: bytes(1) }] }));
        send(loadMsg({ requestId: 'b', files: [{ name: 'second', data: bytes(2) }] }));
        await settle();
        expect(order).toEqual(['start first']);
        release();
        await settle(); await settle();
        expect(order).toEqual(['start first', 'end first', 'start second', 'end second']);
    });

    it('stops listening after dispose', async () => {
        const { api, send, settle, loadFiles } = setup();
        api.dispose();
        send(loadMsg());
        await settle();
        expect(loadFiles).not.toHaveBeenCalled();
    });
});

describe('embed API: validation', () => {
    it.each([
        ['wrong protocol', { protocol: 2 }, ERROR.unsupportedProtocol],
        ['missing protocol', { protocol: undefined }, ERROR.unsupportedProtocol],
        ['missing request id', { requestId: undefined }, ERROR.invalidMessage],
        ['non-string request id', { requestId: 7 }, ERROR.invalidMessage],
        ['overlong request id', { requestId: 'x'.repeat(129) }, ERROR.invalidMessage],
        ['no files', { files: [] }, ERROR.invalidMessage],
        ['files not an array', { files: 'a' }, ERROR.invalidMessage],
        ['too many files', { files: Array.from({ length: MAX_FILES + 1 }, () => ({ name: 'x', data: bytes(1) })) }, ERROR.invalidMessage],
        ['data not binary', { files: [{ name: 'x', data: 'text' }] }, ERROR.invalidMessage],
        ['empty data', { files: [{ name: 'x', data: new ArrayBuffer(0) }] }, ERROR.invalidMessage],
        ['missing entry', { files: [null] }, ERROR.invalidMessage],
    ])('rejects %s', async (_label, extra, error) => {
        expect(parseLoadMessage(loadMsg(extra))).toMatchObject({ ok: false, error });
        const { parent, send, settle, loadFiles } = setup();
        send(loadMsg(extra));
        await settle();
        expect(loadFiles).not.toHaveBeenCalled();
        expect(parent.postMessage.mock.calls[0][0]).toMatchObject({ type: MESSAGE.error, error });
    });

    it('copies exactly the bytes of a typed-array view', () => {
        const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
        const parsed = parseLoadMessage(loadMsg({ files: [{ name: 'v', data: backing.subarray(2, 5) }] }));
        expect(parsed.ok).toBe(true);
        expect([...new Uint8Array(parsed.files[0].data)]).toEqual([1, 2, 3]);
    });

    it.each([
        ['../../etc/passwd', 'passwd'],
        ['C:\\Users\\me\\trace.json', 'trace.json'],
        ['a\u0000b\u001fc.qlog', 'abc.qlog'],
        ['', 'file-1'],
        [undefined, 'file-1'],
        ['dir/', 'file-1'],
        ['x'.repeat(300), 'x'.repeat(255)],
    ])('sanitizes the name %j to %j', (input, expected) => {
        expect(sanitizeFileName(input, 0)).toBe(expected);
    });
});
