/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const fixture = path.join(ROOT, 'tests/fixtures/chrome-google.har.json');

// The canvas renderer draws via requestAnimationFrame and can repaint more
// than once in quick succession (initial layout, then a resize-observer
// pass once the container's real width settles) — a single boundingBox()
// read right after triggering a render risks sampling a transient
// intermediate height rather than the settled one. Poll until the height
// stops changing for a short window before treating it as authoritative.
async function waitForStableHeight(canvas, { timeoutMs = 15000, stableForMs = 300 } = {}) {
    const start = Date.now();
    let lastHeight = null;
    let lastChangeAt = Date.now();
    for (;;) {
        const box = await canvas.boundingBox();
        const height = box ? box.height : 0;
        if (height !== lastHeight) {
            lastHeight = height;
            lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= stableForMs) {
            return lastHeight;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`canvas height did not stabilize within ${timeoutMs}ms (last=${lastHeight})`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

// End-to-end smoke test for the URL/domain waterfall filter: loads a real HAR
// through the viewer's file-drop path, types a pattern into the "URL / domain
// pattern" Options field, and confirms (1) the value round-trips into the
// shareable URL's packed `options=` query param and (2) the render actually
// narrows the visible request set. Also proves Connection View bypasses the
// filter without erroring (`layout.js#calculateRows` explicitly skips the
// urlFilter pass when `options.connectionView` is set).
test('urlFilter narrows visible requests and Connection View bypasses it', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto('/');

    // Real file-input path (mirrors viewer-embed-iframe.spec.js).
    await page.locator('input[type=file]').first().setInputFiles(fixture);

    const canvas = page.locator('#waterfall-view canvas');
    await canvas.waitFor({ state: 'visible', timeout: 30000 });

    // Give the initial (unfiltered) render a moment to settle, then capture
    // its height as the "all requests" baseline.
    const unfilteredHeight = await waitForStableHeight(canvas);
    expect(unfilteredHeight).toBeGreaterThan(0);

    // Open Options and type a domain filter (the "Domain pattern" field)
    // that only a subset of the fixture's hosts match (www.google.com,
    // accounts.google.com, etc. — NOT lh3.googleusercontent.com /
    // fonts.gstatic.com / www.gstatic.com).
    await page.locator('#btn-settings').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/hidden/);

    const urlFilterInput = page.locator('#ui-url-filter');
    await urlFilterInput.fill('google.com');

    await page.locator('#btn-settings-close').click();
    await expect(page.locator('#settings-overlay')).toHaveClass(/hidden/);

    // The viewer packs non-default render options into a single `options=`
    // query param as `key:value` pairs (see updateUrlWithCurrentState() /
    // getOptionsFromUrl() in viewer.js) rather than a standalone
    // `urlFilter=` param, so decode it via URLSearchParams instead of
    // pattern-matching the raw query string.
    await expect.poll(() => {
        const params = new URL(page.url()).searchParams;
        return params.get('options') || '';
    }, { timeout: 10000 }).toContain('urlFilter:google.com');

    // The filtered render should contain visibly fewer requests than the
    // unfiltered baseline (a real narrowing, not a no-op).
    const filteredHeight = await waitForStableHeight(canvas);
    expect(filteredHeight).toBeLessThan(unfilteredHeight);

    // Switch to Connection View — urlFilter must be bypassed there
    // (layout.js only applies it when `!options.connectionView`), and the
    // canvas must keep rendering without throwing.
    await page.locator('#btn-settings').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/hidden/);
    await page.locator('input[name="ui-view-type"][value="connection"]').check();
    await page.locator('#btn-settings-close').click();

    await expect(canvas).toBeVisible();
    expect(await waitForStableHeight(canvas)).toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
});
