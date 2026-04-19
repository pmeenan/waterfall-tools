#!/usr/bin/env node
/*
 * Copyright 2026 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Bundle `dist/browser/` (including the `devtools-<version>/` subtree) into
 * `waterfall-tools-viewer-<version>.zip` at the repo root — a drop-in static
 * web root for users who want to host the viewer without going through npm.
 *
 * Intended to be chained from `postpublish` so a publish produces both the
 * npm tarball and this zip side-by-side. Can also be run standalone via
 * `npm run package-release` to preview the output.
 *
 * Shells out to the `zip` CLI rather than pulling a Node zip library: it's
 * preinstalled on every Unix, keeps the dep tree lean, and the publisher
 * machine already needs `git`/`npm`/`node` — one more standard tool is fine.
 */

import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf-8'));
    const version = pkg.version;
    const distBrowser = path.join(repoRoot, 'dist', 'browser');

    if (!existsSync(distBrowser)) {
        console.error('dist/browser/ not found. Run `npm run build` first.');
        process.exit(1);
    }

    const outName = `waterfall-tools-viewer-${version}.zip`;
    const outPath = path.join(repoRoot, outName);

    // Remove any leftover from a previous run so `zip` doesn't append.
    await rm(outPath, { force: true });

    console.log(`Packaging ${outName} from dist/browser/ ...`);

    await new Promise((resolve, reject) => {
        // cwd = dist/browser so archive paths are relative to the viewer root
        // (`index.html`, `devtools-<version>/...`) with no `dist/browser/` prefix.
        const zip = spawn('zip', ['-r', '-q', outPath, '.'], {
            cwd: distBrowser,
            stdio: 'inherit'
        });
        zip.on('error', err => {
            reject(new Error(`Failed to run \`zip\`: ${err.message}. Install the zip CLI and retry.`));
        });
        zip.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`zip exited with code ${code}`));
        });
    });

    const { size } = await stat(outPath);
    console.log(`Wrote ${outName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => {
    console.error('package-release failed:', err);
    process.exit(1);
});
