/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
export class NativeCanvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        if (typeof OffscreenCanvas !== 'undefined') {
            this.canvas = new OffscreenCanvas(width, height);
        } else {
            this.canvas = document.createElement('canvas');
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    getCanvas() {
        return this.canvas;
    }
}

/**
 * Create a browser canvas (OffscreenCanvas when available, else a detached <canvas>).
 * Async to share the platform-canvas-impl signature with the Node implementation,
 * which must lazily import its optional native dependency.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<OffscreenCanvas|HTMLCanvasElement>}
 */
export async function createNativeCanvas(width, height) {
    return new NativeCanvas(width, height).getCanvas();
}
