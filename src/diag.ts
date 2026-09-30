import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const HOST_KEY = 'norikae.diag.host'
const CHUNK_KEY = 'norikae.diag.chunk.'
const CHUNKS = 16
const CHUNK_CHARS = 1 << 20
const out = document.querySelector('#out')!
const lines: string[] = []

// ブラウザ側の保存領域は起動ごとに origin（ポート）が変わって空になるので、記録はすべて Even 側に置く。
type HostRecord = { results?: string[]; origin?: string; memTrying?: number; memMaxMB?: number; chunks?: number; chunkSample?: string }

const bridgeWait = Promise.race([waitForEvenAppBridge(), new Promise<undefined>(r => setTimeout(r, 3000))])
let bridge: EvenAppBridge | undefined
let glassesReady: Promise<unknown> | undefined

async function report(line: string, keep = false) {
  lines.push(line)
  if (keep) await saveHost({ results: [...((await host()).results ?? []), line] })
  out.textContent = lines.join('\n')
  if (!bridge) return
  await glassesReady
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'diag', content: lines.slice(-10).join('\n') }),
  )
}

async function host(): Promise<HostRecord> {
  return JSON.parse((await bridge?.getLocalStorage(HOST_KEY)) || '{}')
}

async function saveHost(patch: HostRecord) {
  await bridge?.setLocalStorage(HOST_KEY, JSON.stringify({ ...(await host()), ...patch }))
}

// SIMD とスレッドの最小モジュール。validate が true なら、その命令を WebView の WASM が解釈できる。
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
const THREADS = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11])

const seconds = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1)

async function bundled() {
  await report('同梱ファイルを読み込み中…')
  const t0 = performance.now()
  const res = await fetch('./diag-model.bin')
  const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0
  await report(`同梱ファイル: HTTP ${res.status}  ${Math.round(bytes / 1048576)}MB  ${seconds(t0)}秒`, true)
}

async function hostBench() {
  if (!bridge) return report('Even の bridge なし')
  const b = bridge
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const chunk = Array.from({ length: CHUNK_CHARS }, (_, i) => alphabet[(i * 7919) % 64]).join('')
  await report(`Even側に ${CHUNKS}MB を書き込み中…`)
  let t0 = performance.now()
  for (let i = 0; i < CHUNKS; i++) {
    if (!(await b.setLocalStorage(CHUNK_KEY + i, chunk))) return report(`書き込み失敗: ${i}MB 目`)
  }
  const write = seconds(t0)
  t0 = performance.now()
  let same = 0
  for (let i = 0; i < CHUNKS; i++) if ((await b.getLocalStorage(CHUNK_KEY + i)) === chunk) same++
  const read = seconds(t0)
  await saveHost({ chunks: CHUNKS, chunkSample: chunk.slice(0, 32) })
  await report(`Even側 ${CHUNKS}MB: 書き込み ${write}秒  読み込み ${read}秒  一致 ${same}/${CHUNKS}`, true)
  await report(`→ 226MB(モデル169MBをbase64化)なら読み込み約 ${Math.round((Number(read) / CHUNKS) * 226)}秒`, true)
}

async function memory() {
  const STEP = 1024
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 65536 })
  let mb = 0
  for (;;) {
    await saveHost({ memTrying: mb + 64 })
    try {
      mem.grow(STEP)
    } catch {
      await saveHost({ memTrying: 0 })
      break
    }
    new Uint8Array(mem.buffer, mb * 1048576, 64 * 1048576).fill(1)
    mb += 64
    await saveHost({ memMaxMB: mb, memTrying: 0 })
    if (mb % 256 === 0) await report(`メモリ ${mb}MB 確保`)
  }
  await report(`メモリ上限: ${mb}MB（例外で停止）`)
}

async function main() {
  await report(`origin: ${location.origin}  secure: ${isSecureContext}`)
  bridge = await bridgeWait
  if (!bridge) return report('Even の bridge なし（ブラウザで開いている）')
  const page = {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0, paddingLength: 4,
        containerID: 1, containerName: 'diag', content: '診断中…', isEventCapture: 1,
      }),
    ],
  }
  // 乗換案内の画面から開いた場合はスタートページが既にあり、create は失敗する。
  glassesReady = bridge
    .createStartUpPageContainer(new CreateStartUpPageContainer(page))
    .then(r => r === 0 || bridge!.rebuildPageContainer(new RebuildPageContainer(page)))

  const h = await host()
  await report(`前回の origin: ${h.origin ?? 'なし'}`)
  for (const r of h.results ?? []) await report(`記録: ${r}`)
  if (h.chunks) {
    const first = await bridge.getLocalStorage(CHUNK_KEY + '0')
    await report(`前回 Even側に書いた ${h.chunks}MB: ${first.startsWith(h.chunkSample ?? '?') ? '残っている' : '消えた'}`)
  }
  if (h.memTrying) await report(`前回のメモリ測定は ${h.memTrying}MB 確保中に落ちた（成功は ${h.memMaxMB ?? 0}MB まで）`)
  else if (h.memMaxMB) await report(`前回のメモリ上限: ${h.memMaxMB}MB`)
  await saveHost({ origin: location.origin })

  await report(`crossOriginIsolated: ${self.crossOriginIsolated ?? '未対応'}  SIMD: ${WebAssembly.validate(SIMD)}  threads: ${WebAssembly.validate(THREADS)}`)
  await report(`UA: ${navigator.userAgent}`)
}

const run = (f: () => Promise<unknown>) => () => f().catch(e => report(`失敗: ${e}`))
document.querySelector('#bundled')!.addEventListener('click', run(bundled))
document.querySelector('#host')!.addEventListener('click', run(hostBench))
document.querySelector('#memory')!.addEventListener('click', run(memory))
document.querySelector('#copy')!.addEventListener('click', () => navigator.clipboard.writeText(lines.join('\n')))
main()
