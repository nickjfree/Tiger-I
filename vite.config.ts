import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the production build can be served from any sub-path.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
