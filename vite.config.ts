import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the production build can be served from any sub-path.
  base: './',
  server: {
    // dev: forward the battle-room socket to the game server (npm run server)
    proxy: { '/ws': { target: 'http://localhost:8080', ws: true } },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
