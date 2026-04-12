/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export async function createCanvas(width, height) {
    if (typeof window !== 'undefined' && window.document) {
        const { BrowserCanvas } = await import('./browser/canvas-browser.js');
        const canvasWrapper = new BrowserCanvas(width, height);
        return canvasWrapper.getCanvas();
    } else {
        const { NodeCanvas } = await import('./node/canvas-node.js');
        const canvasWrapper = new NodeCanvas(width, height);
        return canvasWrapper.getCanvas();
    }
}
