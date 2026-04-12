/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import * as Impl from 'platform-canvas-impl';

export async function createCanvas(width, height) {
    const CanvasClass = Impl.NodeCanvas || Impl.BrowserCanvas;
    const canvasWrapper = new CanvasClass(width, height);
    return canvasWrapper.getCanvas();
}
