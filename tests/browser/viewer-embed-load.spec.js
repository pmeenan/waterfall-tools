import fs from 'node:fs';
import http from 'node:http';
import { expect, test } from '@playwright/test';

// The postMessage load API (src/viewer/embed-api.js) end to end: a page on another origin
// frames the real viewer, waits for 'ready', posts a result as a transferred ArrayBuffer, and
// gets 'loaded' back to its own origin while the viewer renders it. Also checks that a payload
// the viewer cannot parse comes back as a bare error code.

// The embedder is a real HTTP server on its own loopback port: a different origin from the dev
// viewer, and a local one. A page Playwright fulfils itself has no network address, so Chrome
// treats it as public and its local-network-access block stops it framing the loopback viewer,
// something the real deployment (a public embedder framing the public viewer) never meets.
const SAMPLE = 'Sample/Data/HARs/Chrome/www.google.com.har';

const embedderPage = (viewerUrl) => `<!doctype html><meta charset=utf-8>
<iframe id=viewer src="${viewerUrl}" style="width:1200px;height:800px"></iframe>
<script>
window.replies = [];
window.ready = new Promise((resolve) => {
    addEventListener('message', (e) => {
        if (e.source !== document.getElementById('viewer').contentWindow) return;
        if (e.data && e.data.type === 'waterfall-tools:ready') resolve({ origin: e.origin, data: e.data });
        else window.replies.push({ origin: e.origin, data: e.data });
    });
});
window.post = async (requestId, files) => {
    const viewer = document.getElementById('viewer').contentWindow;
    const transfer = files.map((f) => f.data);
    viewer.postMessage({ type: 'waterfall-tools:load', protocol: 1, requestId, files }, new URL(document.getElementById('viewer').src).origin, transfer);
    return transfer.map((b) => b.byteLength); // 0 once transferred
};
</script>`;

test('an embedder on another origin loads a result by postMessage', async ({ page, baseURL }) => {
    const viewerUrl = new URL('/', baseURL).href;
    const server = http.createServer((req, res) => {
        if (req.url === '/sample.har') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fs.readFileSync(SAMPLE));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(embedderPage(viewerUrl));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const embedder = `http://127.0.0.1:${server.address().port}`;
        expect(embedder).not.toBe(new URL(baseURL).origin);
        await page.goto(`${embedder}/`);

        const ready = await page.evaluate(() => window.ready);
        expect(ready.data).toEqual({ type: 'waterfall-tools:ready', protocol: 1 });
        expect(ready.origin).toBe(new URL(baseURL).origin);

        const remaining = await page.evaluate(async () => {
            const data = await (await fetch('/sample.har')).arrayBuffer();
            return window.post('har-1', [{ name: 'www.google.com.har', data }]);
        });
        expect(remaining).toEqual([0]); // the buffer was transferred, not copied

        await expect.poll(() => page.evaluate(() => window.replies.length), { timeout: 60000 }).toBe(1);
        const [reply] = await page.evaluate(() => window.replies);
        expect(reply.data).toEqual({ protocol: 1, type: 'waterfall-tools:loaded', requestId: 'har-1' });

        const viewer = page.frameLocator('#viewer');
        await expect(viewer.locator('#canvas-container')).toBeVisible();
        await expect(viewer.locator('#drop-zone')).toBeHidden();

        // A payload no parser recognizes: a bare error code, nothing echoed back.
        await page.evaluate(() => window.post('junk-1', [{ name: 'secret-name.bin', data: new TextEncoder().encode('not a capture format at all').buffer }]));
        await expect.poll(() => page.evaluate(() => window.replies.length), { timeout: 30000 }).toBe(2);
        const replies = await page.evaluate(() => window.replies);
        expect(replies[1].data).toEqual({ protocol: 1, type: 'waterfall-tools:error', requestId: 'junk-1', error: 'load-failed' });
        expect(JSON.stringify(replies[1])).not.toContain('secret');
    } finally {
        server.close();
    }
});
