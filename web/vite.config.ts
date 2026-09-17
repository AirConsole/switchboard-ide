import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const serverPort = Number(process.env.SWB_PORT ?? 8083)
const target = `http://127.0.0.1:${serverPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned to IPv4: Vite's default `localhost` binds [::1] only here, so
    // http://127.0.0.1:5240 is refused while http://localhost:5240 works, which
    // is a confusing difference when the API server binds 127.0.0.1.
    host: process.env.SWB_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.SWB_WEB_PORT ?? 5240),
    strictPort: true,
    // The API and the terminal socket live on the backend; everything else is
    // served by Vite in dev. `ws: true` is what makes terminals work here.
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
