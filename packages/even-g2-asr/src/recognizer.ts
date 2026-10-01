import type { ModelFiles } from './model.ts'
import type { Reply, Request } from './worker.ts'

export type Recognizer = {
  /** 16kHz mono、-1〜1 の音声を認識した文字列。呼んだ順に1つずつ認識する。音声は複製して渡すので、呼んだ後も使ってよい。 */
  recognize(pcm16k: Float32Array): Promise<string>
}

/**
 * 認識器を Worker の中に作る。認識の間もメインスレッド（タップ、画面の更新、マイクの受け取り）は止まらない。
 * hotwords と score は sherpa.ts の createSherpa を見ること。
 * files の配列の ArrayBuffer は Worker に移して（transfer）手放すので、呼んだ後は使わないこと。
 */
export function createRecognizer(files: ModelFiles, hotwords: string[], score = 1.5): Promise<Recognizer> {
  // Vite はこの形の new Worker を見て、Worker とその先の WASM を dist に出す。
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve(text: string): void; reject(err: Error): void }>()
  let next = 1

  const request = (id: number, message: Request, transfer: Transferable[] = []) =>
    new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage(message, transfer)
    })
  worker.addEventListener('message', (e: MessageEvent<Reply>) => {
    const r = e.data
    const p = pending.get(r.id)
    pending.delete(r.id)
    if ('error' in r) p?.reject(new Error(r.error))
    else p?.resolve(r.text)
  })
  // Worker のスクリプトが読めないときや、WASM が落ちて Worker ごと止まったとき。
  worker.addEventListener('error', e => {
    for (const p of pending.values()) p.reject(new Error(`音声認識の Worker が止まりました（${e.message || 'unknown'}）`))
    pending.clear()
  })

  const buffers = [...new Set(Object.values(files).map(f => f.buffer))]
  return request(0, { kind: 'create', files, hotwords, score }, buffers).then(() => ({
    recognize: pcm => {
      const id = next++
      return request(id, { kind: 'recognize', id, pcm })
    },
  }))
}
