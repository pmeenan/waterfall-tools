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

async function loadQuicheCapture(page) {
    const loadId = `events-${Date.now()}`;
    const qlogBytes = readMaybeGzip('Sample/Data/qlog/quiche/quiche-localhost-client.sqlog.gz');

    // No hash on purpose: the embedded default route must land on /events
    // (pins the embed contract the waterfall-tools viewer relies on).
    await page.goto(qvisPath(`index.html?embedded=1&loadId=${encodeURIComponent(loadId)}`));
    await expect(page).toHaveURL(/#\/events$/);
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
}

test('embedded qvis Events tab renders, filters, and links stream context', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await loadQuicheCapture(page);

    // 1. Events nav link exists and precedes Sequence in DOM order.
    const eventsLink = page.getByRole('link', { name: 'Events' });
    const sequenceLink = page.getByRole('link', { name: 'Sequence' });
    await expect(eventsLink).toBeVisible();
    await expect(sequenceLink).toBeVisible();

    const navOrder = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('#MainMenu a.nav-link'));
        return links.map(link => link.textContent.trim());
    });
    const eventsIndex = navOrder.findIndex(text => text === 'Events');
    const sequenceIndex = navOrder.findIndex(text => text === 'Sequence');
    expect(eventsIndex).toBeGreaterThanOrEqual(0);
    expect(sequenceIndex).toBeGreaterThanOrEqual(0);
    expect(eventsIndex).toBeLessThan(sequenceIndex);

    // 2. Already on /events (embedded default route redirect) -> left list
    // renders with a virtualized (partial) DOM row set.
    await expect(page).toHaveURL(/#\/events$/);

    const footer = page.locator('.eventlog-list-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveText(/\d+ \/ \d+ events/);

    const footerText = await footer.textContent();
    const footerMatch = footerText.match(/(\d+)\s*\/\s*(\d+)\s*events/);
    expect(footerMatch).not.toBeNull();
    const initialVisibleCount = Number(footerMatch[1]);
    const totalCount = Number(footerMatch[2]);
    expect(totalCount).toBeGreaterThan(0);
    expect(initialVisibleCount).toBe(totalCount);

    const rowCountBeforeFilter = await page.locator('.eventlog-list-row').count();
    expect(rowCountBeforeFilter).toBeGreaterThan(0);
    expect(rowCountBeforeFilter).toBeLessThan(100);
    expect(totalCount).toBeGreaterThan(rowCountBeforeFilter);

    // 3. Filter to a term that shrinks the list; wait out the 150ms debounce.
    const filterInput = page.getByLabel('Filter events');
    await filterInput.fill('frame_parsed');
    await page.waitForTimeout(400);

    const filteredFooterText = await footer.textContent();
    const filteredMatch = filteredFooterText.match(/(\d+)\s*\/\s*(\d+)\s*events/);
    expect(filteredMatch).not.toBeNull();
    const filteredVisibleCount = Number(filteredMatch[1]);
    const filteredTotalCount = Number(filteredMatch[2]);
    expect(filteredTotalCount).toBe(totalCount);
    expect(filteredVisibleCount).toBeLessThan(totalCount);
    expect(filteredVisibleCount).toBeGreaterThan(0);

    const visibleTypeTexts = await page.locator('.eventlog-list-row .col-type').allTextContents();
    const visibleSummaryTexts = await page.locator('.eventlog-list-row .col-summary').allTextContents();
    expect(visibleTypeTexts.length).toBeGreaterThan(0);
    const spotCheckCount = Math.min(5, visibleTypeTexts.length);
    for (let i = 0; i < spotCheckCount; i++) {
        const haystack = `${visibleTypeTexts[i]} ${visibleSummaryTexts[i]}`.toLowerCase();
        expect(haystack).toContain('frame_parsed');
    }

    // 4. Clear the filter, click the first visible row -> details heading + JSON.
    await filterInput.fill('');
    await page.waitForTimeout(400);
    await expect(footer).toHaveText(new RegExp(`${totalCount} / ${totalCount} events`));

    const firstRow = page.locator('.eventlog-list-row').first();
    await firstRow.click();

    const detailsHeading = page.locator('.eventlog-details-heading');
    await expect(detailsHeading).toBeVisible();
    await expect(detailsHeading).toHaveText(/^#\d+ · \+\d+\.\d{3} ms · .+/);

    const detailsJsonText = (await page.locator('.eventlog-json').textContent()).trim();
    expect(detailsJsonText.length).toBeGreaterThan(0);
    expect(detailsJsonText[0] === '{' || detailsJsonText[0] === '[').toBe(true);
    expect(() => JSON.parse(detailsJsonText)).not.toThrow();

    // 5. Select an event associated with a stream (frame_parsed events all carry a
    // direct data.stream_id in this capture) and inspect the stream-context list.
    await filterInput.fill('frame_parsed');
    await page.waitForTimeout(400);

    const streamRow = page.locator('.eventlog-list-row').first();
    await streamRow.click();

    const contextSeparators = page.locator('.eventlog-context-separator-label');
    await expect(contextSeparators.first()).toBeVisible();
    const separatorTexts = await contextSeparators.allTextContents();
    expect(separatorTexts.length).toBeGreaterThan(0);
    for (const text of separatorTexts) {
        expect(text).toMatch(/#\d+ · \+\d+\.\d{3} ms/);
    }

    await expect(page.locator('.eventlog-context-block.selected')).toHaveCount(1);
    await expect(page.locator('.eventlog-list-row.selected')).toHaveCount(1);

    // quiche never carries frames for two+ streams in one packet in this capture, so
    // a single-stream label (not pills) is expected here.
    const singleStreamLabel = page.locator('.eventlog-stream-single');
    let previousStreamLabelText = null;
    if (await singleStreamLabel.count() > 0) {
        previousStreamLabelText = await singleStreamLabel.textContent();
    }

    // 6. Click a different, non-selected context block -> details heading seq changes
    // and the stream label (if single) stays the same. Selecting a context block whose
    // seq is filtered out of the active left-list filter is a documented, valid state
    // (the renderer keeps the selection and simply shows no `.selected` left-list row),
    // so clear the filter first to keep this assertion about the *context* list, not an
    // incidental interaction with the still-active "frame_parsed" filter.
    await filterInput.fill('');
    await page.waitForTimeout(400);

    const selectedSeqText = await page.locator('.eventlog-details-heading').textContent();
    const contextBlocks = page.locator('.eventlog-context-block');
    const contextBlockCount = await contextBlocks.count();
    expect(contextBlockCount).toBeGreaterThan(0);

    // Scroll the left list far away first so the scroll-to-selection behavior below
    // is actually exercised (with the list at rest near the selection, scrollToIndex
    // would be a no-op and this step would prove nothing).
    await page.locator('.eventlog-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(100);

    let clicked = false;
    for (let i = 0; i < contextBlockCount; i++) {
        const block = contextBlocks.nth(i);
        const isSelected = (await block.getAttribute('class') || '').includes('selected');
        if (!isSelected) {
            await block.click();
            clicked = true;
            break;
        }
    }
    expect(clicked).toBe(true);

    const newSeqText = await page.locator('.eventlog-details-heading').textContent();
    expect(newSeqText).not.toBe(selectedSeqText);
    await expect(page.locator('.eventlog-context-block.selected')).toHaveCount(1);

    // The left list auto-scrolls the new selection back into its virtualization
    // window (scrollToIndex no-ops when already visible, so direct left-list clicks
    // never move the list). The selected row must therefore exist in the DOM again
    // and sit inside the visible list area.
    const selectedListRow = page.locator('.eventlog-list-row.selected');
    await expect(selectedListRow).toHaveCount(1);
    const listBox = await page.locator('.eventlog-list').boundingBox();
    const selRowBox = await selectedListRow.boundingBox();
    expect(selRowBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
    expect(selRowBox.y + selRowBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);

    if (previousStreamLabelText !== null && await singleStreamLabel.count() > 0) {
        await expect(singleStreamLabel).toHaveText(previousStreamLabelText);
    }

    // 7. Draggable splitter: the divider exists, a real mouse drag moves the
    // pane boundary in the drag direction, and the 20%..80% clamps hold.
    const divider = page.locator('.eventlog-divider');
    await expect(divider).toBeVisible();

    const splitBox = await page.locator('.eventlog-split').boundingBox();
    const leftBoxBefore = await page.locator('.eventlog-left').boundingBox();
    expect(splitBox).not.toBeNull();
    expect(leftBoxBefore).not.toBeNull();

    let dividerBox = await divider.boundingBox();
    const dragY = dividerBox.y + Math.min(50, dividerBox.height / 2);

    // drag 200px to the left -> left pane shrinks by ~200px (still above the 20% floor)
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dragY);
    await page.mouse.down();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2 - 200, dragY, { steps: 8 });
    await page.mouse.up();

    const leftBoxAfter = await page.locator('.eventlog-left').boundingBox();
    expect(leftBoxAfter.width).toBeLessThan(leftBoxBefore.width - 150);
    expect(leftBoxAfter.width).toBeGreaterThanOrEqual(splitBox.width * 0.20 - 2);

    // drag far past the left edge -> clamped at the 20% floor, never below
    dividerBox = await divider.boundingBox();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dragY);
    await page.mouse.down();
    await page.mouse.move(splitBox.x - 50, dragY, { steps: 5 });
    await page.mouse.up();

    const leftBoxClamped = await page.locator('.eventlog-left').boundingBox();
    expect(leftBoxClamped.width).toBeGreaterThanOrEqual(splitBox.width * 0.20 - 2);
    expect(leftBoxClamped.width).toBeLessThanOrEqual(splitBox.width * 0.20 + 8);

    // drag far past the right edge -> clamped at the 80% ceiling
    dividerBox = await divider.boundingBox();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dragY);
    await page.mouse.down();
    await page.mouse.move(splitBox.x + splitBox.width + 50, dragY, { steps: 5 });
    await page.mouse.up();

    const leftBoxMax = await page.locator('.eventlog-left').boundingBox();
    expect(leftBoxMax.width).toBeGreaterThanOrEqual(splitBox.width * 0.80 - 8);
    expect(leftBoxMax.width).toBeLessThanOrEqual(splitBox.width * 0.80 + 2);

    // 8. Draggable horizontal splitter in the right pane: the divider between the
    // details JSON and the stream context resizes them, and the 15%..85% clamps hold.
    // (An event with stream context is still selected from the earlier steps.)
    const hDivider = page.locator('.eventlog-hdivider');
    await expect(hDivider).toBeVisible();

    const rightBox = await page.locator('.eventlog-right').boundingBox();
    const detailsBoxBefore = await page.locator('.eventlog-details').boundingBox();
    expect(rightBox).not.toBeNull();
    expect(detailsBoxBefore).not.toBeNull();

    let hDividerBox = await hDivider.boundingBox();
    const dragX = hDividerBox.x + Math.min(50, hDividerBox.width / 2);

    // drag 120px down -> details section grows by ~120px (still under the 85% ceiling)
    await page.mouse.move(dragX, hDividerBox.y + hDividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragX, hDividerBox.y + hDividerBox.height / 2 + 120, { steps: 8 });
    await page.mouse.up();

    const detailsBoxAfter = await page.locator('.eventlog-details').boundingBox();
    expect(detailsBoxAfter.height).toBeGreaterThan(detailsBoxBefore.height + 80);

    // drag far past the top edge -> clamped at the 15% floor (the 80px min-height can
    // hold the pane slightly above the pure percent floor, so clamp to the larger of
    // the two as the effective floor)
    hDividerBox = await hDivider.boundingBox();
    await page.mouse.move(dragX, hDividerBox.y + hDividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragX, rightBox.y - 50, { steps: 5 });
    await page.mouse.up();

    const detailsBoxClamped = await page.locator('.eventlog-details').boundingBox();
    const effectiveFloor = Math.max(rightBox.height * 0.15, 80);
    expect(detailsBoxClamped.height).toBeGreaterThanOrEqual(effectiveFloor - 2);
    expect(detailsBoxClamped.height).toBeLessThanOrEqual(effectiveFloor + 8);

    // drag far past the bottom edge -> clamped at the 85% ceiling
    hDividerBox = await hDivider.boundingBox();
    await page.mouse.move(dragX, hDividerBox.y + hDividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragX, rightBox.y + rightBox.height + 50, { steps: 5 });
    await page.mouse.up();

    const detailsBoxMax = await page.locator('.eventlog-details').boundingBox();
    expect(detailsBoxMax.height).toBeGreaterThanOrEqual(rightBox.height * 0.85 - 8);
    expect(detailsBoxMax.height).toBeLessThanOrEqual(rightBox.height * 0.85 + 2);

    // 9. No page errors observed throughout the flow.
    expect(pageErrors).toEqual([]);
});
