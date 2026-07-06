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

async function loadCaptures(page, loadId, captures) {
    // No hash on purpose: the embedded default route must land on /events.
    await page.goto(qvisPath(`index.html?embedded=1&loadId=${encodeURIComponent(loadId)}`));
    await expect(page).toHaveURL(/#\/events$/);
    await expect(page.getByRole('link', { name: 'Sequence' })).toBeVisible();

    await page.evaluate(({ loadId: embeddedLoadId, files }) => {
        const decoded = files.map(file => {
            const binary = atob(file.base64);
            const data = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                data[i] = binary.charCodeAt(i);
            }
            return { name: file.name, data: data.buffer };
        });

        window.postMessage({
            type: 'qvis-load-files',
            loadId: embeddedLoadId,
            files: decoded,
        }, window.location.origin);
    }, {
        loadId,
        files: captures.map(capture => ({
            name: capture.name,
            base64: Buffer.from(readMaybeGzip(capture.path)).toString('base64'),
        })),
    });

    await expect(page.getByText('Loaded embedded qlog files')).toBeVisible();
}

test('single-file load hides every trace picker, even after visiting Sequence', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await loadCaptures(page, `picker-single-${Date.now()}`, [
        { name: 'quiche-localhost-client.sqlog', path: 'Sample/Data/qlog/quiche/quiche-localhost-client.sqlog.gz' },
    ]);

    // Events tab (embedded default): exactly one real trace -> no connection picker,
    // no helper text, but the filter bar must remain fully present.
    await expect(page.locator('.eventlog-list-footer')).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(0);
    await expect(page.getByText('Select a trace via the dropdown(s)')).toHaveCount(0);
    await expect(page.getByLabel('Filter events')).toBeVisible();
    await expect(page.getByLabel('Filter by category')).toBeVisible();

    // Stats tab: single real group -> picker + helper text hidden, content still renders.
    await page.getByRole('link', { name: 'qlog stats' }).click();
    await expect(page).toHaveURL(/#\/stats$/);
    await expect(page.getByRole('heading', { name: 'File info' })).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(0);
    await expect(page.getByText('Select a file via the dropdown(s)')).toHaveCount(0);

    // Congestion tab: picker hidden, and the zoom/ruler toolbar buttons lay out inline.
    // (Regression: the buttons sat directly inside a Bootstrap .row, and Bootstrap 5's
    // anonymous-column selector (.row > *) forced each to width:100%, stacking them.)
    await page.getByRole('link', { name: 'Congestion' }).click();
    await expect(page).toHaveURL(/#\/congestion$/);
    await expect(page.locator('.connection-configurator')).toHaveCount(0);
    const resetZoomBtn = page.getByRole('button', { name: 'Reset zoom' });
    const zoomTimerangeBtn = page.getByRole('button', { name: 'Zoom timerange' });
    await expect(resetZoomBtn).toBeVisible();
    await expect(zoomTimerangeBtn).toBeVisible();
    const resetBox = await resetZoomBtn.boundingBox();
    const timerangeBox = await zoomTimerangeBtn.boundingBox();
    // side by side on the same line, each far narrower than the viewport
    expect(resetBox.y).toBe(timerangeBox.y);
    expect(resetBox.width).toBeLessThan(page.viewportSize().width / 2);

    // Sequence tab: its configurator hides too (the only "choice" would be the original
    // vs its simulated clone), and the renderer still auto-generates the sibling lane.
    await page.getByRole('link', { name: 'Sequence' }).click();
    await expect(page).toHaveURL(/#\/sequence$/);
    await expect(page.locator('.connection-configurator')).toHaveCount(0);
    await expect(page.getByText('Select one or more traces via the dropdown(s)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add trace' })).toHaveCount(0);
    // the auto-generated sibling lane renders its "GENERATED: <filename>" header text
    await expect(page.locator('#sequence-diagram-svg')).toBeVisible();
    await expect(page.locator('#sequence-diagram-svg text', { hasText: 'GENERATED:' }).first())
        .toBeAttached({ timeout: 10000 });

    // Back to Events: the sequence renderer registered its simulated clone on the shared
    // connection group — that must NOT resurface the picker (clones are not real options).
    await page.getByRole('link', { name: 'Events' }).click();
    await expect(page).toHaveURL(/#\/events$/);
    await expect(page.locator('.eventlog-list-footer')).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(0);
    await expect(page.getByLabel('Filter events')).toBeVisible();

    // Stats again for good measure: still hidden after the clone exists.
    await page.getByRole('link', { name: 'qlog stats' }).click();
    await expect(page.getByRole('heading', { name: 'File info' })).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
});

test('multi-file load shows pickers with only real (non-autogenerated) options', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await loadCaptures(page, `picker-multi-${Date.now()}`, [
        { name: 'quiche-localhost-client.sqlog', path: 'Sample/Data/qlog/quiche/quiche-localhost-client.sqlog.gz' },
        { name: 'quiche-localhost-server.sqlog', path: 'Sample/Data/qlog/quiche/quiche-localhost-server.sqlog.gz' },
    ]);

    // Events tab: two real traces -> the picker IS shown.
    await expect(page.locator('.eventlog-list-footer')).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(1);
    await expect(page.getByText('Select a trace via the dropdown(s)')).toBeVisible();
    await expect(page.getByLabel('Filter events')).toBeVisible();

    // Visit Sequence first so its renderer gets the chance to register autogenerated
    // clones (with two real vantage points it pairs them instead, but keep the order
    // representative of real usage), then verify the Events picker options.
    await page.getByRole('link', { name: 'Sequence' }).click();
    await expect(page.locator('#sequence-diagram-svg')).toBeVisible();

    await page.getByRole('link', { name: 'Events' }).click();
    await expect(page.locator('.connection-configurator')).toHaveCount(1);

    const optionTexts = await page.locator('.connection-configurator option').allTextContents();
    // exactly the two real connections are selectable (combined-select mode also lists
    // one disabled filename header per group)
    const connectionOptions = optionTexts.filter(text => text.includes('↳'));
    expect(connectionOptions.length).toBe(2);
    for (const text of optionTexts) {
        expect(text.toLowerCase()).not.toContain('autogenerated');
    }
    const joined = optionTexts.join('\n');
    expect(joined).toContain('quiche-localhost-client.sqlog');
    expect(joined).toContain('quiche-localhost-server.sqlog');

    // Stats tab with two real groups keeps its picker as well, with no autogenerated entries.
    await page.getByRole('link', { name: 'qlog stats' }).click();
    await expect(page.getByRole('heading', { name: 'File info' }).first()).toBeVisible();
    await expect(page.locator('.connection-configurator')).toHaveCount(1);
    const statsOptionTexts = await page.locator('.connection-configurator option').allTextContents();
    expect(statsOptionTexts.length).toBe(2);
    for (const text of statsOptionTexts) {
        expect(text.toLowerCase()).not.toContain('autogenerated');
    }

    expect(pageErrors).toEqual([]);
});
