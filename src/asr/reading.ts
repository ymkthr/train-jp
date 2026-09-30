// 文字列をひらがなの読みにする。kuromoji（IPADIC）の辞書は、ブラウザでは public/kuromoji（npm install で node_modules から写す）、
// Node（テストと scripts）では node_modules/kuromoji/dict から読む。どちらもネットには取りに行かない。
// kuromoji の builder は使わず、辞書を自分で読んで Tokenizer を作る。builder のブラウザ用の読み込みは .gz を必ず自分で展開するので、
// 配る側が Content-Encoding: gzip を付けて（Vite の開発サーバーはそうする）ブラウザが先に展開すると壊れる。
// @ts-expect-error kuromoji の src には型が無い
import KuromojiTokenizer from 'kuromoji/src/Tokenizer.js'
// @ts-expect-error kuromoji の src には型が無い
import DynamicDictionaries from 'kuromoji/src/dict/DynamicDictionaries.js'

export const LETTERS: Record<string, string> = {
  A: 'エー', B: 'ビー', C: 'シー', D: 'ディー', E: 'イー', F: 'エフ', G: 'ジー', H: 'エイチ', I: 'アイ', J: 'ジェイ', K: 'ケー', L: 'エル', M: 'エム',
  N: 'エヌ', O: 'オー', P: 'ピー', Q: 'キュー', R: 'アール', S: 'エス', T: 'ティー', U: 'ユー', V: 'ブイ', W: 'ダブリュー', X: 'エックス', Y: 'ワイ', Z: 'ゼット',
}

/** カタカナをひらがなにする。「ヶ」は駅名ではたいてい「が」と読むので「が」にする。 */
export const hiragana = (s: string) => s.replace(/[ァ-ヴ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replaceAll('ヶ', 'が')

type Token = { surface_form: string; reading?: string }
type Tokenizer = { tokenize(text: string): Token[] }

// fs は Node にしか無いので静的には読めない。型の無い node の fs を、Vite にも tsc にも見せずに Node でだけ読む。
const NODE_FS = 'node:fs/promises'

async function dictFile(name: string): Promise<ArrayBuffer> {
  const raw =
    typeof window === 'undefined'
      ? new Uint8Array(await (await import(/* @vite-ignore */ NODE_FS)).readFile(`node_modules/kuromoji/dict/${name}.dat.gz`))
      : new Uint8Array(await (await fetch(`kuromoji/${name}.dat.gz`)).arrayBuffer())
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) return raw.buffer
  return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

async function loadTokenizer(): Promise<Tokenizer> {
  const names = ['base', 'check', 'tid', 'tid_pos', 'tid_map', 'cc', 'unk', 'unk_pos', 'unk_map', 'unk_char', 'unk_compat', 'unk_invoke']
  const [base, check, tid, tidPos, tidMap, cc, unk, unkPos, unkMap, unkChar, unkCompat, unkInvoke] = await Promise.all(names.map(dictFile))
  // 型付き配列の種類は kuromoji の src/loader/DictionaryLoader.js に合わせる。
  const dic = new DynamicDictionaries()
  dic.loadTrie(new Int32Array(base), new Int32Array(check))
  dic.loadTokenInfoDictionaries(new Uint8Array(tid), new Uint8Array(tidPos), new Uint8Array(tidMap))
  dic.loadConnectionCosts(new Int16Array(cc))
  dic.loadUnknownDictionaries(
    new Uint8Array(unk), new Uint8Array(unkPos), new Uint8Array(unkMap), new Uint8Array(unkChar), new Uint32Array(unkCompat), new Uint8Array(unkInvoke),
  )
  return new KuromojiTokenizer(dic)
}

let tokenizer: Promise<Tokenizer> | undefined

/** 辞書は初めて呼んだときに読む（数百 ms）。読みの無い語（英字など）は、英字を読みのカタカナにしてそのまま使う。 */
export async function reading(text: string): Promise<string> {
  tokenizer ??= loadTokenizer()
  const tokens = (await tokenizer).tokenize(text)
  return hiragana(tokens.map(t => t.reading ?? t.surface_form.replace(/[A-Za-z]/g, c => LETTERS[c.toUpperCase()])).join(''))
}
