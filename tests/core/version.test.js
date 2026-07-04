/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/core/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('library version', () => {
    it('src/core/version.js matches package.json (the HAR creator version source)', () => {
        // VERSION is a literal (not a package.json import) so it stays consumable from raw
        // Node CLI wrappers and browser bundles alike — this test is what keeps it honest.
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
        expect(VERSION).toBe(pkg.version);
    });
});
