import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { patchDevtoolsBundle } from './scripts/patch-devtools.js';

// Read the installed Chrome DevTools frontend version so the dev server can route
// /devtools-<version>/ at the same versioned path that production uses. Matching
// the URL shape in both modes keeps the viewer code path identical.
const devtoolsPkg = JSON.parse(readFileSync(resolve(__dirname, 'node_modules/@chrome-devtools/index/package.json'), 'utf-8'));
const devtoolsVersion = devtoolsPkg.version;
const devtoolsDirName = `devtools-${devtoolsVersion}`;
const devtoolsRoot = resolve(__dirname, 'node_modules/@chrome-devtools/index');
const devtoolsPrefix = `/${devtoolsDirName}/`;
const QVIS_PACKAGE_NAME = '@pmeenan/qvis';

function resolveOptionalQvis() {
  const forkDist = resolve(__dirname, 'third_party/qvis/visualizations/dist');
  const forkPkgPath = resolve(__dirname, 'third_party/qvis/visualizations/package.json');
  if (existsSync(forkDist) && existsSync(forkPkgPath)) {
    const qvisPkg = JSON.parse(readFileSync(forkPkgPath, 'utf-8'));
    return {
      dirName: `qvis-${qvisPkg.version}`,
      root: forkDist
    };
  }

  try {
    const qvisPkgPath = resolve(__dirname, `node_modules/${QVIS_PACKAGE_NAME}/package.json`);
    const qvisPkg = JSON.parse(readFileSync(qvisPkgPath, 'utf-8'));
    const packageDist = resolve(qvisPkgPath, '..', 'dist');
    if (!existsSync(packageDist)) return null;
    return {
      dirName: `qvis-${qvisPkg.version}`,
      root: packageDist
    };
  } catch {
    return null;
  }
}

const qvisAsset = resolveOptionalQvis();
const qvisPrefix = qvisAsset ? `/${qvisAsset.dirName}/` : null;

function serveStaticFrom(root, prefix, patcher = null) {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith(prefix)) return next();
    const rel = req.url.slice(prefix.length).split('?')[0].split('#')[0];
    // Normalize and keep inside root
    const safe = rel.replace(/\\/g, '/').split('/').filter(p => p && p !== '..').join('/');
    const filePath = resolve(root, safe || 'index.html');
    if (!filePath.startsWith(root)) return next();
    try {
      let buf = readFileSync(filePath);
      const ext = filePath.split('.').pop().toLowerCase();
      if (patcher && (ext === 'js' || ext === 'mjs')) {
        const patched = patcher(buf.toString('utf-8'));
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
        jpeg: 'image/jpeg',
        avif: 'image/avif',
        wasm: 'application/wasm',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', ctype);
      res.end(buf);
    } catch {
      next();
    }
  };
}

const devtoolsServePlugin = {
  name: 'waterfall-tools-optional-viewer-assets',
  transformIndexHtml(html) {
    let out = html.replace(
      /<meta name="waterfall-devtools-path"[^>]*>/,
      `<meta name="waterfall-devtools-path" content="./${devtoolsDirName}/">`
    );
    out = out.replace(
      /<meta name="waterfall-qvis-path"[^>]*>/,
      `<meta name="waterfall-qvis-path" content="${qvisAsset ? `./${qvisAsset.dirName}/` : ''}">`
    );
    return out;
  },
  configureServer(server) {
    server.middlewares.use(serveStaticFrom(devtoolsRoot, devtoolsPrefix, patchDevtoolsBundle));
    if (qvisAsset && qvisPrefix) {
      server.middlewares.use(serveStaticFrom(qvisAsset.root, qvisPrefix));
    }
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
