/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

describe('WaterfallTools.getDefaultOptions', () => {
    it('includes an empty urlFilter alongside reqFilter', () => {
        const opts = WaterfallTools.getDefaultOptions();
        expect(opts).toHaveProperty('urlFilter');
        expect(opts.urlFilter).toBe('');
        expect(opts).toHaveProperty('reqFilter');
    });
});
