// sherpa-onnx（offline transducer、modeling_unit=cjkchar）で 16kHz mono の音声を文字にする。呼んだスレッドで同期に動く。
// WASM は wasm/build.sh で作った単一スレッド版。アプリからは recognizer.ts の Worker 越しに使う。
import createSherpaModule from '../wasm/asr.js'
import type { ModelFiles } from './model.ts'

export type Sherpa = {
  /** 16kHz mono、-1〜1 の音声を認識した文字列。 */
  recognize(pcm16k: Float32Array): string
}

// 発話の頭が録音の頭に詰まっていると最初の語を落とす（gTTS の「北十二条」が「十二条」になった）。前後に 0.3 秒の無音を足して渡す。
const PAD_SAMPLES = 4800

/**
 * hotwords は語を1つずつ渡す。tokens.txt にある文字だけで書けた語にすること（無い文字は sherpa が飛ばすので、
 * 途中の文字が抜けた別の語として登録されてしまう）。
 * sherpa は続いた英字を1語にまとめて tokens.txt から引く（「J」「R」はあるが「JR」は無い）ので、1文字ずつ空白で区切って書き出す。
 * score は hotword の1文字ごとに足すボーナス。
 * files の配列は WASM 側に渡して手放すので、呼んだ後は使わないこと。
 */
export async function createSherpa(files: ModelFiles, hotwords: string[], score = 1.5): Promise<Sherpa> {
  const m = await createSherpaModule()

  const lines = [...new Set(hotwords.map(w => [...w.replace(/\s/g, '')].join(' ')))].filter(Boolean)

  // canOwn で渡すと MEMFS は配列を複製せずに持つ。sherpa が読み込んだら消して、JS 側の参照を手放す。
  const paths = { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx', tokens: '/tokens.txt' }
  for (const k of Object.keys(paths) as (keyof ModelFiles)[]) m.FS.writeFile(paths[k], files[k], { canOwn: true })
  const hotwordsPath = lines.length ? '/hotwords.txt' : ''
  if (hotwordsPath) m.FS.writeFile(hotwordsPath, lines.join('\n'))

  const args = [paths.encoder, paths.decoder, paths.joiner, paths.tokens, hotwordsPath].map(s => m.stringToNewUTF8(s))
  const handle = m._asr_create(args[0], args[1], args[2], args[3], args[4], score)
  args.forEach(p => m._free(p))
  for (const p of Object.values(paths)) m.FS.unlink(p)
  if (hotwordsPath) m.FS.unlink(hotwordsPath)
  if (!handle) throw new Error('sherpa-onnx の認識器を作れませんでした')

  return {
    recognize(pcm16k) {
      const n = pcm16k.length + 2 * PAD_SAMPLES
      const samples = m._malloc(n * 4)
      const at = samples / 4
      m.HEAPF32.fill(0, at, at + n)
      m.HEAPF32.set(pcm16k, at + PAD_SAMPLES)
      const text = m._asr_recognize(handle, samples, n)
      m._free(samples)
      const s = m.UTF8ToString(text)
      m._free(text)
      return s
    },
  }
}
