import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    alias: {
      'platform-storage-impl': resolve(__dirname, './src/platforms/node/storage-node.js'),
      'platform-canvas-impl': resolve(__dirname, './src/platforms/node/canvas-node.js')
    }
  }
});
