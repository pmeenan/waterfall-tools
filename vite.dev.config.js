import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { patchNodeWorkerThreadsImport } from './scripts/patch-devtools.js';

// Read the installed Chrome DevTools frontend version so the dev server can route
// /devtools-<version>/ at the same versioned path that production uses. Matching
// the URL shape in both modes keeps the viewer code path identical.
const devtoolsPkg = JSON.parse(readFileSync(resolve(__dirname, 'node_modules/@chrome-devtools/index/package.json'), 'utf-8'));
const devtoolsVersion = devtoolsPkg.version;
const devtoolsDirName = `devtools-${devtoolsVersion}`;
const devtoolsRoot = resolve(__dirname, 'node_modules/@chrome-devtools/index');
const devtoolsPrefix = `/${devtoolsDirName}/`;

const devtoolsServePlugin = {
  name: 'waterfall-tools-devtools-serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta name="waterfall-devtools-path"[^>]*>/,
      `<meta name="waterfall-devtools-path" content="./${devtoolsDirName}/">`
    );
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith(devtoolsPrefix)) return next();
      const rel = req.url.slice(devtoolsPrefix.length).split('?')[0].split('#')[0];
      // Normalize and keep inside devtoolsRoot
      const safe = rel.replace(/\\/g, '/').split('/').filter(p => p && p !== '..').join('/');
      const filePath = resolve(devtoolsRoot, safe || 'index.html');
      if (!filePath.startsWith(devtoolsRoot)) return next();
      try {
        let buf = readFileSync(filePath);
        const ext = filePath.split('.').pop().toLowerCase();
        if (ext === 'js' || ext === 'mjs') {
          const patched = patchNodeWorkerThreadsImport(buf.toString('utf-8'));
          buf = Buffer.from(patched, 'utf-8');
        }
        const ctype = {
          html: 'text/html; charset=utf-8',
          js: 'text/javascript; charset=utf-8',
          mjs: 'text/javascript; charset=utf-8',
          css: 'text/css; charset=utf-8',
          json: 'application/json; charset=utf-8',
          svg: 'image/svg+xml',
          png: 'image/png',
          jpg: 'image/jpeg',
          avif: 'image/avif',
          wasm: 'application/wasm',
          ico: 'image/x-icon',
          woff: 'font/woff',
          woff2: 'font/woff2'
        }[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', ctype);
        res.end(buf);
      } catch (e) {
        next();
      }
    });
  }
};

export default defineConfig({
  root: 'src/viewer',
  plugins: [devtoolsServePlugin],
  resolve: {
    alias: {
      // During UI development, alias the bare specifier directly back to local source code
      // so Hot Module Replacement (HMR) seamlessly updates API side changes in real-time.
      'waterfall-tools': resolve(__dirname, 'src/core/waterfall-tools.js'),
      'platform-canvas-impl': resolve(__dirname, 'src/platforms/browser/canvas-browser.js'),
      'platform-storage-impl': resolve(__dirname, 'src/platforms/browser/storage-browser.js')
    }
  }
});
