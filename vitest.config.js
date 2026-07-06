import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/browser/**',
      'third_party/**'
    ],
    alias: {
      'platform-storage-impl': resolve(__dirname, './src/platforms/node/storage-node.js'),
      'platform-canvas-impl': resolve(__dirname, './src/platforms/node/canvas-node.js')
    }
  }
});
