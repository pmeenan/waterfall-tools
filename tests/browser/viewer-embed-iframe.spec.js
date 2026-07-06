import { expect, test } from '@playwright/test';

// Regression for the embed-iframe baseline gap: <iframe> is inline-level by default,
// so a height:100% iframe inside .tab-content sat on the text baseline and the line
// box reserved ~4px of descender space below it — the container then scrolled by
// those few px even though the iframe's computed height matched the container
// exactly (a permanently visible scrollbar with Windows-style classic scrollbars).
// style.css now forces `.tab-content > iframe { display: block }`; this spec loads a
// real capture through the viewer UI and asserts none of the embed containers
// overflow their content box.
test('embed tab containers do not overflow their iframes', async ({ page }) => {
    await page.goto('/');

    // load the quiche qlog through the real file-input path (gzip sniffed, qvis tab
    // is the embed this input activates; the fix is a shared rule for all of them)
    await page.locator('input[type=file]').first()
        .setInputFiles('Sample/Data/qlog/quiche/quiche-localhost-client.sqlog.gz');

    const qvisTab = page.locator('#tab-qvis');
    await qvisTab.waitFor({ state: 'visible', timeout: 30000 });
    await qvisTab.click();

    // wait for the embed handshake to settle: the qvis iframe reports its load by
    // hiding the loading overlay
    await expect(page.locator('#qvis-overlay')).toBeHidden({ timeout: 30000 });

    const measurements = await page.evaluate(() => {
        const out = {};
        for (const id of ['qvis-view', 'devtools-view', 'trace-view', 'netlog-view', 'lighthouse-view']) {
            const el = document.getElementById(id);
            const iframe = el ? el.querySelector('iframe') : null;
            if (!el || !iframe) {
                continue;
            }
            out[id] = {
                overflowsV: el.scrollHeight > el.clientHeight,
                overflowsH: el.scrollWidth > el.clientWidth,
                iframeDisplay: getComputedStyle(iframe).display,
            };
        }
        return out;
    });

    // every embed container must exist in the DOM regardless of which tabs are
    // active for this input format, and none may overflow
    expect(Object.keys(measurements).sort()).toEqual(
        ['devtools-view', 'lighthouse-view', 'netlog-view', 'qvis-view', 'trace-view']);
    for (const [id, m] of Object.entries(measurements)) {
        expect(m.iframeDisplay, `${id} iframe display`).toBe('block');
        expect(m.overflowsV, `${id} vertical overflow`).toBe(false);
        expect(m.overflowsH, `${id} horizontal overflow`).toBe(false);
    }
});
