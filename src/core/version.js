/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * The library version stamped into HAR `log.creator` blocks by every parser and by
 * `WaterfallTools.getHar()`. A literal (not a package.json import) so the module stays
 * isomorphic — raw Node CLI wrappers and browser bundles both consume it without JSON
 * import-attribute support. `tests/core/version.test.js` asserts it matches package.json,
 * so a version bump that misses this file fails the suite.
 */
export const VERSION = '0.4.0';
