import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(process.cwd(), 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: resolve(process.cwd(), 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: resolve(process.cwd(), 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(process.cwd(), 'src/renderer'),
    resolve: {
      alias: { '@shared': shared, '@': resolve(process.cwd(), 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(process.cwd(), 'src/renderer/index.html') }
    }
  }
})
