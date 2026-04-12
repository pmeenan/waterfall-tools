/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { Layout } from '../renderer/layout.js';
import { createCanvas } from '../platforms/canvas.js';
import { WaterfallCanvas } from '../renderer/canvas.js';

/**
 * Generates an image snapshot of the waterfall view headlessly.
 * Supports outputting raw PNG or JPEG buffers.
 *
 * @param {import('../core/waterfall-tools.js').WaterfallTools} toolsInstance
 * @param {string} pageId 
 * @param {Object} options 
 * @returns {Promise<{ buffer: Uint8Array, mimeType: string, width: number, height: number }>}
 */
export async function generateImage(toolsInstance, pageId, options = {}) {
    const pageData = toolsInstance.getPage(pageId, { includeRequests: true });
    if (!pageData) {
        throw new Error(`Page data not found for ID: ${pageId}`);
    }

    const format = options.format || 'png';
    const mimeType = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
    const quality = options.quality !== undefined ? options.quality : 0.85;

    const width = options.width || 1200;
    const minWidth = options.thumbnailView ? 0 : (options.minWidth || width);
    const canvasWidth = Math.max(minWidth, width);

    // Filter properties to match exactly what renderer does dynamically
    const rawEntries = [];
    if (pageData.requests) {
        Object.values(pageData.requests).forEach(r => rawEntries.push(r));
    }

    // Pass 1: Calculate layout to determine exact Canvas height requirements blindly without rendering
    const layoutOptions = Object.assign({}, options, { page: pageData });
    const drawnRows = Layout.calculateRows(rawEntries, canvasWidth, layoutOptions);

    // Platform-agnostic canvas instance (napi-canvas in Node, OffscreenCanvas/createElement in Browser)
    const canvas = await createCanvas(canvasWidth, drawnRows.dimensions.canvasHeight);

    // Initialize renderer natively targeting isolated canvas bounds
    const renderer = new WaterfallCanvas(null, {
        ...options,
        canvas: canvas,
        width: canvasWidth 
    });

    // Execute synchronous layout processing natively explicitly bypassing requestAnimationFrame asynchronous events
    renderer.pageData = pageData;
    renderer.rawEntries = rawEntries;
    
    // Natively draw the layout onto the target context
    renderer.draw(drawnRows.rows, drawnRows.dimensions, drawnRows.pageEvents);

    // Compile resulting pixel arrays based on the running environment intrinsically
    let buffer;
    if (typeof canvas.toBuffer === 'function') {
        // Node (@napi-rs/canvas)
        buffer = canvas.toBuffer(mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png');
    } else if (typeof canvas.convertToBlob === 'function') {
        // OffscreenCanvas
        const blob = await canvas.convertToBlob({ type: mimeType, quality });
        buffer = new Uint8Array(await blob.arrayBuffer());
    } else if (typeof canvas.toBlob === 'function') {
        // Fallback HTMLCanvasElement
        buffer = await new Promise((resolve) => {
            canvas.toBlob((blob) => {
                blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
            }, mimeType, quality);
        });
    } else if (typeof canvas.toDataURL === 'function') {
        // Fallback DataURL extractor natively (worst-case scenario)
        const dataStr = canvas.toDataURL(mimeType, quality);
        const b64 = dataStr.split(',')[1];
        if (typeof Buffer !== 'undefined') {
            buffer = Buffer.from(b64, 'base64');
        } else {
            const raw = window.atob(b64);
            buffer = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) buffer[i] = raw.charCodeAt(i);
        }
    } else {
        throw new Error("Target canvas container does not support mapping serialization to binary.");
    }

    return {
        buffer,
        mimeType,
        width: canvasWidth,
        height: drawnRows.dimensions.canvasHeight
    };
}
