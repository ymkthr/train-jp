import type { ModelFiles } from './model.ts'
import { createSherpa, type Sherpa } from './sherpa.ts'

export type Request =
  | { kind: 'create'; files: ModelFiles; hotwords: string[]; score: number }
  | { kind: 'recognize'; id: number; pcm: Float32Array }

/** id 0 は create への返事。 */
export type Reply = { id: number; text: string } | { id: number; error: string }

let sherpa: Sherpa | undefined

// 呼び出し側は create の返事を待ってから recognize を送る。WASM の呼び出しは同期なので、届いた順に1つずつ終わる。
addEventListener('message', async (e: MessageEvent<Request>) => {
  const r = e.data
  const id = r.kind === 'create' ? 0 : r.id
  try {
    if (r.kind === 'create') {
      sherpa = await createSherpa(r.files, r.hotwords, r.score)
      postMessage({ id, text: '' } satisfies Reply)
    } else {
      postMessage({ id, text: sherpa!.recognize(r.pcm) } satisfies Reply)
    }
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies Reply)
  }
})
