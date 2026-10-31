/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import * as Impl from 'platform-canvas-impl';

export async function createCanvas(width, height) {
    // Both platform implementations expose an async factory; the Node one lazily imports
    // the optional `@napi-rs/canvas` dependency so it never lands as a static import.
    return await Impl.createNativeCanvas(width, height);
}
