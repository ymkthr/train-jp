// 音声認識の結果や入力された文字列から、出発駅と到着駅の候補を決める。駅の一覧は scripts/build-stations.mjs が作る stations.json にある。
import stations from './stations.json' with { type: 'json' }
import { reading } from './reading.ts'

/**
 * name は駅名、pref と line は同名の駅を見分けるための都道府県と路線の1つ、lat・lon は座標、kana は読み（ひらがな）、
 * aliases は hotwords に登録する表記（tokens.txt にある文字だけで書ける）。同名でも離れた場所の駅は別の Station になる。
 */
export type Station = { name: string; pref: string; line: string; lat: number; lon: number; kana: string[]; aliases: string[] }

/** 路線の多い駅から順に並んでいる。候補もこの順に並べる。 */
export const STATIONS: readonly Station[] = stations

/**
 * stations が1件で sure なら確定。複数なら選んでもらう。sure でないのは読みのあいまい一致で、1件でも選んでもらう。
 * stations が空なら引けなかった。
 */
export type Candidates = { stations: Station[]; sure: boolean }

const MAX_CANDIDATES = 6
// 読みのあいまい一致で候補にする、編集距離を長い方の文字数で割った値の上限。実測で、西千十六条・JRの江・入ヶ池公園・二ツ入り・高玉は
// 正解まで 0.25 以下、入里ヶ池公園が 1/3。2文字の駅名は1字違いでも 0.5 なので候補にしない。
const MAX_DISTANCE = 0.34

const key = (s: string) => s.normalize('NFKC').replace(/[\s、。,.!?・]/g, '').replaceAll('ヶ', 'ケ')

const byName = new Map<string, Station[]>()
const byAlias = new Map<string, Station[]>()
const byKana = new Map<string, Station[]>()
const add = (map: Map<string, Station[]>, k: string, s: Station) => {
  const list = map.get(k) ?? map.set(k, []).get(k)!
  if (!list.includes(s)) list.push(s)
}
for (const s of STATIONS) {
  add(byName, key(s.name), s)
  for (const a of s.aliases) add(byAlias, key(a), s)
  for (const k of s.kana) add(byKana, k, s)
}
const surfaces = new Map(STATIONS.map(s => [s, [...new Set([s.name, ...s.aliases].map(key))]]))

// 駅名の前後に付いてよい語。ひらがな（「えっと」「まで」「です」）と、よく付く漢字の語。
// ponytail: 漢字の語は決め打ちの一覧。「○○まで行きたい」のような言い方で引けない例が出たら足す。
const EXTRA = /^(?:[ぁ-んー]|駅|お願い|願い|行き|下さい)*$/

/**
 * 前後の余りが EXTRA だけになる部分文字列を、長いものから順に返す。かなだけの部分（すすきの）は前後のかなとの境目が決まらず、
 * 「あいうえおかきくけこ」の「おか」のような拾い方をするので、前に何も付かず、後ろが無いか「駅」「まで」などで始まるときだけにする。
 */
function* spans(t: string): Generator<string> {
  for (let n = t.length; n > 0; n--)
    for (let a = 0; a + n <= t.length; a++) {
      const [left, span, right] = [t.slice(0, a), t.slice(a, a + n), t.slice(a + n)]
      if (!EXTRA.test(left) || !EXTRA.test(right)) continue
      if (/^[ぁ-んー]+$/.test(span) && (left || (right && !/^(駅|まで|です|お願い)/.test(right)))) continue
      yield span
    }
}

// 濁点・半濁点だけが違うかなの置き換え（だ↔た）は、連濁や認識の誤りでよく起きるので半分に数える（高玉 たかだま → 高擶 たかたま）。
const base = (c: string) => c.normalize('NFD')[0]

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]
      const y = b[j - 1]
      const swap = x === y ? 0 : base(x) === base(y) ? 0.5 : 1
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + swap)
    }
    prev = row
  }
  return prev[b.length]
}

/** 長い方の文字数で割った編集距離。長さの差だけで MAX_DISTANCE を超えるものは計算しない。 */
function closeness(a: string, b: string): number {
  const longer = Math.max(a.length, b.length)
  return Math.abs(a.length - b.length) / longer > MAX_DISTANCE ? 1 : editDistance(a, b) / longer
}

/** 候補を MAX_CANDIDATES 件までにする。前の候補から 1km 以内の駅（札幌とさっぽろ）は同じ所に着くので省く。 */
function top(list: Station[]): Station[] {
  const out: Station[] = []
  for (const s of list) {
    const near = out.some(o => Math.hypot(o.lat - s.lat, (o.lon - s.lon) * Math.cos((s.lat * Math.PI) / 180)) * 111 < 1)
    if (!near && out.length < MAX_CANDIDATES) out.push(s)
  }
  return out
}

// モデルが書けない字を含む駅（驫木）は、駅名そのものは別名に無く、生成時に読みをそのまま別名にしてある。
const unwritable = (s: Station) => !s.aliases.includes(s.name) && s.aliases.some(a => s.kana.includes(a))

/**
 * 駅名1つ分の文字列（前後に「えっと」「駅まで」などが付いてもよい）を駅の候補にする。
 * ①駅名・別名の完全一致 ②読みの完全一致 ③読みか表記のあいまい一致、の順に試し、引けた段で止める。①②は sure、③は sure でない。
 * ②は同じ読みの駅をすべて候補にする。①は、かなで書かれていれば（とどろき）同じ読みの駅すべて、漢字で書かれていれば（等々力）
 * 同じ読みの駅のうちモデルが書けない字を含む駅（驫木）だけを足す。仙台と川内のようにどちらも書ける同音の駅まで足すと、主要駅の多くで選ばせることになる。
 */
export async function resolveStation(text: string): Promise<Candidates> {
  const parts = [...spans(key(text))]
  for (const p of parts) {
    const hit = byName.get(p) ?? byAlias.get(p)
    if (!hit) continue
    const same = byKana.get(p) ?? hit.flatMap(s => s.kana.flatMap(k => byKana.get(k)!)).filter(unwritable)
    return { stations: top([...hit, ...same]), sure: true }
  }
  const readings = await Promise.all(parts.map(reading))
  for (const r of readings) {
    const hit = byKana.get(r)
    if (hit) return { stations: top(hit), sure: true }
  }
  const scored = STATIONS.map((s, order) => {
    const d = Math.min(
      ...parts.flatMap((p, i) => [...surfaces.get(s)!.map(x => closeness(p, x)), ...s.kana.map(k => closeness(readings[i], k))]),
    )
    return { s, d, order }
  })
  const close = scored.filter(x => x.d <= MAX_DISTANCE).sort((a, b) => a.d - b.d || a.order - b.order)
  return { stations: top(close.map(x => x.s)), sure: false }
}

/** 「○○から××まで」を出発駅と到着駅の候補にする。「から」が無いか、どちらかの駅が引けなければ null。 */
export async function resolveRoute(text: string): Promise<{ from: Candidates; to: Candidates } | null> {
  const t = key(text)
  // 駅名に「から」を含む場合に備えて、「から」の位置を前から順に試す。
  for (let i = t.indexOf('から'); i !== -1; i = t.indexOf('から', i + 1)) {
    const [from, to] = await Promise.all([resolveStation(t.slice(0, i)), resolveStation(t.slice(i + 2))])
    if (from.stations.length && to.stations.length) return { from, to }
  }
  return null
}
