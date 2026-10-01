import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  // 認識の Worker は WASM のグルーを ES module として読む。
  worker: { format: 'es' },
})
