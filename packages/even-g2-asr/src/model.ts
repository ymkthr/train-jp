import { Sha256 } from './sha256.ts'
import type { KeyValueStore } from './store.ts'

export type ModelFile = { url: string; bytes: number; sha256: string }
/** id は保存先のキーに使う。中身を変えたら id も変えること（変えなくても sha256 の違いで取り直すが、古いキーを消せる範囲が変わらない）。 */
export type ModelSpec = { id: string; encoder: ModelFile; decoder: ModelFile; joiner: ModelFile; tokens: ModelFile }
export type ModelFiles = { encoder: Uint8Array; decoder: Uint8Array; joiner: Uint8Array; tokens: Uint8Array }
export type LoadProgress = { phase: 'download' | 'restore'; loaded: number; total: number }

type FileName = keyof ModelFiles
const NAMES: readonly FileName[] = ['encoder', 'decoder', 'joiner', 'tokens']

const HF = 'https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/'

/** ReazonSpeech k2-v2（Apache-2.0）。encoder と joiner は int8。decoder は int8 にすると精度を確かめ直す必要があるので元のまま。 */
export const REAZONSPEECH_K2_V2: ModelSpec = {
  id: 'reazonspeech-k2-v2',
  encoder: { url: `${HF}encoder-epoch-99-avg-1.int8.onnx`, bytes: 154670139, sha256: '2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d' },
  decoder: { url: `${HF}decoder-epoch-99-avg-1.onnx`, bytes: 11767836, sha256: '58b18211ae06265466bfa17172dab574df94f76c8bcb61a3640c28ba860e4124' },
  joiner: { url: `${HF}joiner-epoch-99-avg-1.int8.onnx`, bytes: 2696970, sha256: '49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de' },
  tokens: { url: `${HF}tokens.txt`, bytes: 45754, sha256: '2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def' },
}

const PREFIX = 'even-g2-asr'
const MANIFEST_KEY = `${PREFIX}/manifest`
// base64 にすると 1,048,576 文字。3 の倍数なので、最後のチャンク以外は = で埋まらない。
const CHUNK_BYTES = 786432

/**
 * 保存先にあるチャンクはすべて目録の配置に従う。complete はすべてのファイルを落として sha256 を確かめ、書き終えてから立てる。
 * 書いている途中で落ちても、次の呼び出しは目録から書きかけのキーを辿れる。
 */
type Manifest = { id: string; chunkBytes: number; files: Record<FileName, { bytes: number; sha256: string }>; complete: boolean }

const layout = (spec: ModelSpec, complete: boolean): Manifest => ({
  id: spec.id,
  chunkBytes: CHUNK_BYTES,
  files: Object.fromEntries(NAMES.map(n => [n, { bytes: spec[n].bytes, sha256: spec[n].sha256 }])) as Manifest['files'],
  complete,
})

const sameLayout = (m: Manifest, spec: ModelSpec) =>
  m.id === spec.id && m.chunkBytes === CHUNK_BYTES && NAMES.every(n => m.files[n].bytes === spec[n].bytes && m.files[n].sha256 === spec[n].sha256)

const chunkKey = (id: string, name: FileName, i: number) => `${PREFIX}/${id}/${name}/${i}`

async function readManifest(store: KeyValueStore): Promise<Manifest | null> {
  const text = await store.get(MANIFEST_KEY)
  if (!text) return null
  try {
    const m: unknown = JSON.parse(text)
    return isManifest(m) ? m : null
  } catch {
    return null
  }
}

function isManifest(m: unknown): m is Manifest {
  if (typeof m !== 'object' || m === null) return false
  const { id, chunkBytes, files, complete } = m as Record<string, unknown>
  if (typeof id !== 'string' || typeof chunkBytes !== 'number' || chunkBytes <= 0 || typeof complete !== 'boolean') return false
  if (typeof files !== 'object' || files === null) return false
  return NAMES.every(n => {
    const f = (files as Record<string, unknown>)[n]
    return typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).bytes === 'number' && typeof (f as Record<string, unknown>).sha256 === 'string'
  })
}

async function put(store: KeyValueStore, key: string, value: string) {
  if (!(await store.set(key, value))) throw new Error(`保存できませんでした（${key}）。端末の空き容量を確かめてください`)
}

/** store に揃っていると目録が言っているか。チャンクの中身までは読まない。 */
export async function isModelCached(spec: ModelSpec, store: KeyValueStore): Promise<boolean> {
  const m = await readManifest(store)
  return !!m && m.complete && sameLayout(m, spec)
}

/**
 * store に揃っていれば復元し、無い・欠けている・spec が変わったときだけダウンロードして store に書く。
 * 復元ではチャンクの有無と長さを確かめ、sha256 は確かめない（毎回の起動で 170MB をハッシュしないため）。
 */
export async function loadModel(spec: ModelSpec, store: KeyValueStore, onProgress?: (p: LoadProgress) => void): Promise<ModelFiles> {
  const sum = NAMES.reduce((n, name) => n + spec[name].bytes, 0)
  const m = await readManifest(store)
  if (m && sameLayout(m, spec)) {
    if (m.complete) {
      const files = await restore(spec, store, loaded => onProgress?.({ phase: 'restore', loaded, total: sum }))
      if (files) return files
    }
  } else if (m) {
    await forget(m, store)
  }
  await put(store, MANIFEST_KEY, JSON.stringify(layout(spec, false)))
  const files = await download(spec, store, loaded => onProgress?.({ phase: 'download', loaded, total: sum }))
  await put(store, MANIFEST_KEY, JSON.stringify(layout(spec, true)))
  return files
}

// 削除が無い保存先なので空文字で上書きする。目録はこの後で新しいものに書き換わるので、途中で落ちても次の呼び出しでまたここに来る。
async function forget(m: Manifest, store: KeyValueStore) {
  for (const name of NAMES)
    for (let i = 0; i < Math.ceil(m.files[name].bytes / m.chunkBytes); i++) await put(store, chunkKey(m.id, name, i), '')
}

async function restore(spec: ModelSpec, store: KeyValueStore, progress: (loaded: number) => void): Promise<ModelFiles | null> {
  let loaded = 0
  const files: [FileName, Uint8Array][] = []
  for (const name of NAMES) {
    // 文字列を溜めずに、先に確保した配列へ1チャンクずつ書き込む。
    const out = new Uint8Array(spec[name].bytes)
    for (let i = 0; i * CHUNK_BYTES < out.length; i++) {
      const at = i * CHUNK_BYTES
      const n = Math.min(CHUNK_BYTES, out.length - at)
      if (!decodeInto(await store.get(chunkKey(spec.id, name, i)), out, at, n)) return null
      loaded += n
      progress(loaded)
    }
    files.push([name, out])
  }
  return Object.fromEntries(files) as ModelFiles
}

async function download(spec: ModelSpec, store: KeyValueStore, progress: (loaded: number) => void): Promise<ModelFiles> {
  let loaded = 0
  const files: [FileName, Uint8Array][] = []
  for (const name of NAMES) {
    const file = spec[name]
    // 中身は store に入れるので、HTTP キャッシュにも同じ 170MB を残さない。
    const res = await fetch(file.url, { cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error(`モデルを取得できませんでした（${name}: HTTP ${res.status}）`)
    const out = new Uint8Array(file.bytes)
    const hash = new Sha256()
    const reader = res.body.getReader()
    let filled = 0
    let saved = 0
    const save = async (end: number) => {
      await put(store, chunkKey(spec.id, name, saved / CHUNK_BYTES), toBase64(out.subarray(saved, end)))
      saved = end
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (filled + value.length > out.length) {
        await reader.cancel()
        throw new Error(`モデルの大きさが違います（${name}: ${file.bytes} バイトのはず）`)
      }
      out.set(value, filled)
      hash.update(value)
      filled += value.length
      loaded += value.length
      while (saved + CHUNK_BYTES <= filled) await save(saved + CHUNK_BYTES)
      progress(loaded)
    }
    if (filled !== out.length) throw new Error(`モデルの大きさが違います（${name}: ${filled} / ${file.bytes} バイト）`)
    if (saved < filled) await save(filled)
    if (hash.hex() !== file.sha256) throw new Error(`モデルが壊れています（${name} の sha256 が一致しません）`)
    files.push([name, out])
  }
  return Object.fromEntries(files) as ModelFiles
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function decodeInto(base64: string, out: Uint8Array, at: number, n: number): boolean {
  let s: string
  try {
    s = atob(base64)
  } catch {
    return false
  }
  if (s.length !== n) return false
  for (let i = 0; i < n; i++) out[at + i] = s.charCodeAt(i)
  return true
}
