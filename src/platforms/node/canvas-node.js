/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

// `@napi-rs/canvas` is an OPTIONAL dependency. It must only ever be loaded lazily via a
// dynamic import: a static import is hoisted by Rollup into the dist/node main chunk,
// which would make every consumer (including the CLI, which never renders images) fail
// with ERR_MODULE_NOT_FOUND when the optional native module isn't installed.
let napiModulePromise = null;

async function loadNapiCanvas() {
    if (!napiModulePromise) {
        napiModulePromise = import('@napi-rs/canvas').catch((e) => {
            napiModulePromise = null; // allow a retry after the user installs it
            const err = new Error(
                'Headless image generation in Node requires the optional dependency "@napi-rs/canvas". ' +
                'Install it with `npm install @napi-rs/canvas`. (' + (e && e.message ? e.message : e) + ')'
            );
            err.cause = e;
            throw err;
        });
    }
    return napiModulePromise;
}

export class NativeCanvas {
    /**
     * @param {number} width
     * @param {number} height
     * @param {Function} napiCreateCanvas - `createCanvas` from `@napi-rs/canvas`
     */
    constructor(width, height, napiCreateCanvas) {
        this.width = width;
        this.height = height;
        this.canvas = napiCreateCanvas(width, height);
        // Add a mock style object to prevent rendering logic failures if it assumes DOM elements
        this.canvas.style = {};
    }

    getCanvas() {
        return this.canvas;
    }
}

/**
 * Create a native canvas, lazily loading `@napi-rs/canvas`.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Object>} The `@napi-rs/canvas` Canvas instance
 */
export async function createNativeCanvas(width, height) {
    const mod = await loadNapiCanvas();
    const napiCreateCanvas = mod.createCanvas || (mod.default && mod.default.createCanvas);
    if (typeof napiCreateCanvas !== 'function') {
        throw new Error('"@napi-rs/canvas" is installed but does not export createCanvas().');
    }
    return new NativeCanvas(width, height, napiCreateCanvas).getCanvas();
}
