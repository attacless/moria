import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@crypto': resolve(__dirname, 'src/crypto'),
      '@transport': resolve(__dirname, 'src/transport'),
      '@hooks': resolve(__dirname, 'src/hooks'),
      '@components': resolve(__dirname, 'src/components'),
      '@types': resolve(__dirname, 'src/types'),
      '@/security': resolve(__dirname, 'src/security'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@noble/')) return 'crypto'
          if (id.includes('trystero') || id.includes('nostr-tools')) return 'transport'
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
})
