// sherpa-onnx（ReazonSpeech の zipformer transducer）で 16kHz mono の音声を文字にする。
// WASM は sherpa-wasm/build.sh で作った単一スレッド版を public/sherpa から読む。

export type ModelFiles = { encoder: Uint8Array; decoder: Uint8Array; joiner: Uint8Array; tokens: Uint8Array }

export type Recognizer = {
  /** 16kHz mono、-1〜1 の音声を認識した文字列。 */
  recognize(pcm16k: Float32Array): string
  /** WASM のメモリの大きさ。メモリは縮まないので、これまでの最大値でもある。 */
  readonly heapBytes: number
}

type SherpaModule = {
  FS: { writeFile(path: string, data: Uint8Array | string, opts?: { canOwn?: boolean }): void; unlink(path: string): void }
  HEAPU8: Uint8Array
  HEAPF32: Float32Array
  UTF8ToString(ptr: number): string
  stringToNewUTF8(s: string): number
  _malloc(size: number): number
  _free(ptr: number): void
  _norikae_create(encoder: number, decoder: number, joiner: number, tokens: number, hotwords: number, score: number): number
  _norikae_recognize(recognizer: number, samples: number, n: number): number
}

/**
 * hotwords は駅名などを1つずつ渡す。tokens.txt にある文字だけで書けた語にすること（無い文字は sherpa が飛ばすので、
 * 途中の文字が抜けた別の語として登録されてしまう。stations.json の別名は生成時に確かめてある）。
 * sherpa は続いた英字を1語にまとめて tokens.txt から引く（「J」「R」はあるが「JR」は無い）ので、1文字ずつ空白で区切って書き出す。
 * score は hotword の1文字ごとに足すボーナス。
 */
export async function createRecognizer(files: ModelFiles, hotwords: string[], score = 1.5): Promise<Recognizer> {
  // グルーは public に置くビルド済みファイルで、Vite の依存グラフに入れられないので実行時に URL から読む。
  const url = new URL('sherpa/norikae-asr.js', document.baseURI).href
  const { default: createSherpaModule } = await import(/* @vite-ignore */ url)
  const m: SherpaModule = await createSherpaModule()

  const lines = [...new Set(hotwords.map(w => [...w.replace(/\s/g, '')].join(' ')))].filter(Boolean)

  // canOwn で渡すと MEMFS は配列を複製せずに持つ。sherpa が読み込んだら消して、JS 側の参照を手放す。
  const paths = { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx', tokens: '/tokens.txt' }
  for (const k of Object.keys(paths) as (keyof ModelFiles)[]) m.FS.writeFile(paths[k], files[k], { canOwn: true })
  const hotwordsPath = lines.length ? '/hotwords.txt' : ''
  if (hotwordsPath) m.FS.writeFile(hotwordsPath, lines.join('\n'))

  const args = [paths.encoder, paths.decoder, paths.joiner, paths.tokens, hotwordsPath].map(s => m.stringToNewUTF8(s))
  const handle = m._norikae_create(args[0], args[1], args[2], args[3], args[4], score)
  args.forEach(p => m._free(p))
  for (const p of Object.values(paths)) m.FS.unlink(p)
  if (hotwordsPath) m.FS.unlink(hotwordsPath)
  if (!handle) throw new Error('sherpa-onnx の認識器を作れませんでした')

  return {
    recognize(pcm16k) {
      const samples = m._malloc(pcm16k.length * 4)
      m.HEAPF32.set(pcm16k, samples / 4)
      const text = m._norikae_recognize(handle, samples, pcm16k.length)
      m._free(samples)
      const s = m.UTF8ToString(text)
      m._free(text)
      return s
    },
    get heapBytes() {
      return m.HEAPU8.buffer.byteLength
    },
  }
}

/** G2 のマイクから届く s16le（リトルエンディアン 16bit）のバイト列を -1〜1 にする。 */
export function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
