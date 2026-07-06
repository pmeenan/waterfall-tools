import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const qvisPackage = JSON.parse(readFileSync(path.join(ROOT, 'third_party/qvis/visualizations/package.json'), 'utf-8'));

function readMaybeGzip(relativePath) {
    const bytes = readFileSync(path.join(ROOT, relativePath));
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return gunzipSync(bytes);
    }
    return bytes;
}

function qvisPath(pathname) {
    return `/qvis-${qvisPackage.version}/${pathname}`;
}

test('embedded qvis stats tab renders without locking the page', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    const loadId = `stats-${Date.now()}`;
    const qlogBytes = readMaybeGzip('Sample/Data/qlog/quiche/quiche-localhost-client.sqlog.gz');

    await page.goto(qvisPath(`index.html?embedded=1&loadId=${encodeURIComponent(loadId)}#/sequence`));
    await expect(page.getByRole('link', { name: 'Sequence' })).toBeVisible();

    await page.evaluate(({ loadId: embeddedLoadId, base64 }) => {
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            data[i] = binary.charCodeAt(i);
        }

        window.postMessage({
            type: 'qvis-load-files',
            loadId: embeddedLoadId,
            files: [{
                name: 'quiche-localhost-client.sqlog',
                data: data.buffer,
            }],
        }, window.location.origin);
    }, {
        loadId,
        base64: Buffer.from(qlogBytes).toString('base64'),
    });

    await expect(page.getByText('Loaded embedded qlog files')).toBeVisible();

    await page.getByRole('link', { name: 'qlog stats' }).click();
    await expect(page).toHaveURL(/#\/stats$/);
    await expect(page.getByRole('heading', { name: 'File info' })).toBeVisible();
    await expect(page.getByText('Trace count')).toBeVisible();
    // Scoped to the stats table cell: a plain getByText('Events') is ambiguous once the
    // "Events" nav link (Phase 15) is also on the page.
    await expect(page.getByRole('cell', { name: 'Events', exact: true })).toBeVisible();

    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
    expect(pageErrors).toEqual([]);
});
