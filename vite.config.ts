import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // 診断ページで、WebView がこのヘッダを受けて crossOriginIsolated になるかを確かめる。
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  build: { target: 'esnext', rollupOptions: { input: ['index.html', 'diag.html'] } },
})
