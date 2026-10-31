/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Rebuild `third_party/qvis/visualizations/dist` before Playwright runs when the
 * qvis source checkout is present; no-op cleanly when it isn't (e.g. a fresh clone
 * without the submodule, where `vite.dev.config.js` and `scripts/build.js` fall
 * back to the installed `node_modules/@pmeenan/qvis/dist` package).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const qvisDir = path.resolve(__dirname, '../third_party/qvis/visualizations');
const qvisPkgPath = path.join(qvisDir, 'package.json');

if (!existsSync(qvisPkgPath)) {
    console.log('[build-qvis-if-present] third_party/qvis/visualizations not present; using installed @pmeenan/qvis dist if available.');
    process.exit(0);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(path.join(qvisDir, 'node_modules'))) {
    console.log('[build-qvis-if-present] Installing third_party/qvis/visualizations dependencies...');
    execFileSync(npmCmd, ['ci', '--prefix', qvisDir], { stdio: 'inherit' });
}

execFileSync(npmCmd, ['--prefix', qvisDir, 'run', 'build'], { stdio: 'inherit' });
