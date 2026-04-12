import { createCanvas as napiCreateCanvas } from '@napi-rs/canvas';

export class NodeCanvas {
    constructor(width, height) {
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
