export class BrowserCanvas {
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
