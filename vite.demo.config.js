import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/demo',
  resolve: {
    alias: {
      'platform-canvas-impl': resolve(__dirname, 'src/platforms/browser/canvas-browser.js'),
      'platform-storage-impl': resolve(__dirname, 'src/platforms/browser/storage-browser.js')
    }
  },
  build: {
    outDir: '../../bin/demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/demo/index.html'),
        canvas: resolve(__dirname, 'src/demo/canvas/index.html')
      }
    }
  }
});
