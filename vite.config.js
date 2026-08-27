import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  optimizeDeps: {
    // rapier ships a wasm bundle; let Vite pre-bundle it so dev start is fast.
    exclude: [],
  },
});
