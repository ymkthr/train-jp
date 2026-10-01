// build.sh の emcc が書き出す関数と実行時のメソッドだけを型にする。

export type SherpaModule = {
  FS: { writeFile(path: string, data: Uint8Array | string, opts?: { canOwn?: boolean }): void; unlink(path: string): void }
  HEAPU8: Uint8Array
  HEAPF32: Float32Array
  UTF8ToString(ptr: number): string
  stringToNewUTF8(s: string): number
  _malloc(size: number): number
  _free(ptr: number): void
  _asr_create(encoder: number, decoder: number, joiner: number, tokens: number, hotwords: number, score: number): number
  _asr_recognize(recognizer: number, samples: number, n: number): number
}

export default function createSherpaModule(): Promise<SherpaModule>
