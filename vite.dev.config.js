import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/viewer',
  resolve: {
    alias: {
      // During UI development, alias the bare specifier directly back to local source code
      // so Hot Module Replacement (HMR) seamlessly updates API side changes in real-time.
      'waterfall-tools': resolve(__dirname, 'src/core/waterfall-tools.js')
    }
  }
});
