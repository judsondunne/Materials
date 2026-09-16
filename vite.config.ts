import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { aiPlugin } from './server/plugin';

export default defineConfig({
  plugins: [react(), aiPlugin()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // three.js is the bulk of the bundle and it never changes between
        // builds of this app, so it gets its own chunk: the browser caches it
        // once and the application's own code stays small enough to re-download
        // without thinking about it.
        manualChunks: { three: ['three'] },
      },
    },
    chunkSizeWarningLimit: 800,
  },
});
