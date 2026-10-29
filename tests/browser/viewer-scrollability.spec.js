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

test('landing page scrolls vertically without clipping on small viewports', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.setViewportSize({ width: 375, height: 420 });
    await page.goto('/');

    const dropZone = page.locator('#drop-zone');
    await dropZone.waitFor({ state: 'visible', timeout: 15000 });

    const initialMetrics = await page.evaluate(() => {
        const dz = document.getElementById('drop-zone');
        const card = document.querySelector('.landing-content');
        const dzRect = dz.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        return {
            overflowY: getComputedStyle(dz).overflowY,
            scrollTop: dz.scrollTop,
            scrollHeight: dz.scrollHeight,
            clientHeight: dz.clientHeight,
            scrollWidth: dz.scrollWidth,
            clientWidth: dz.clientWidth,
            cardTopRelative: cardRect.top - dzRect.top
        };
    });

    expect(initialMetrics.overflowY).toBe('auto');
    expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);
    expect(initialMetrics.scrollWidth).toBeLessThanOrEqual(initialMetrics.clientWidth);
    // Top of .landing-content must not be pushed into unreachable negative scroll space.
    expect(initialMetrics.cardTopRelative).toBeGreaterThanOrEqual(0);

    const scrolledMetrics = await page.evaluate(() => {
        const dz = document.getElementById('drop-zone');
        dz.scrollTop = dz.scrollHeight;
        const dzRect = dz.getBoundingClientRect();
        const linkRect = document.querySelector('.github-link').getBoundingClientRect();
        const uploadRect = document.getElementById('upload-btn').getBoundingClientRect();
        return {
            scrollTop: dz.scrollTop,
            linkBottomRelative: linkRect.bottom - dzRect.bottom,
            uploadVisible: uploadRect.bottom <= dzRect.bottom && uploadRect.top >= dzRect.top - uploadRect.height
        };
    });

    expect(scrolledMetrics.scrollTop).toBeGreaterThan(0);
    expect(scrolledMetrics.linkBottomRelative).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
});

test('split labels drawer syncs vertical scroll with waterfall view on narrow viewports', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.setViewportSize({ width: 900, height: 360 });
    await page.goto('/');

    await page.locator('input[type=file]').first().setInputFiles(fixture);

    const canvas = page.locator('#waterfall-view canvas');
    await canvas.waitFor({ state: 'visible', timeout: 30000 });

    const labelsSlider = page.locator('#labels-slider');
    await expect(labelsSlider).toHaveClass(/\bactive\b/);

    // Scroll the main waterfall view and verify the split labels container follows.
    await page.evaluate(() => {
        const wf = document.getElementById('waterfall-view');
        wf.scrollTop = 180;
        wf.dispatchEvent(new Event('scroll'));
    });

    await expect.poll(async () => {
        return page.evaluate(() => document.getElementById('labels-slider-content').scrollTop);
    }).toBe(180);

    // Open the labels drawer, scroll it directly, and verify the waterfall view follows.
    await page.locator('#labels-slider-toggle').click();
    await expect(labelsSlider).toHaveClass(/\bopen\b/);

    await page.evaluate(() => {
        const lc = document.getElementById('labels-slider-content');
        lc.scrollTop = 95;
        lc.dispatchEvent(new Event('scroll'));
    });

    await expect.poll(async () => {
        return page.evaluate(() => document.getElementById('waterfall-view').scrollTop);
    }).toBe(95);

    // Resizing above 1200px deactivates the split labels slider when labels move inline.
    await page.setViewportSize({ width: 1300, height: 600 });
    await expect(labelsSlider).not.toHaveClass(/\bactive\b/);
    expect(pageErrors).toEqual([]);
});

