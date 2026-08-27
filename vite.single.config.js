// Build for the Artifact host: one HTML file, everything inlined.
// Artifacts run under a CSP that blocks every external host, so nothing may be
// fetched at runtime — no chunks, no CSS file, no assets.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',
    outDir: 'dist-single',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    sourcemap: false,
    chunkSizeWarningLimit: 100000,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
