// src/asr/stations.json を作る。駅名・都道府県・路線・座標は HeartRails Express、読みは Wikidata（CC0）、Wikidata に無ければ
// 日本語版 Wikipedia、それも無ければ kuromoji で駅名から作る。使える文字はモデルの tokens.txt から。
// 使い方: npm run build:stations   （取ってきたデータは WORK、既定は /tmp/train-jp-stations に置いて次から使う。消すと取り直す）
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { LETTERS, hiragana, reading } from '../src/asr/reading.ts'

const WORK = process.env.WORK ?? '/tmp/train-jp-stations'
const OUT = new URL('../src/asr/stations.json', import.meta.url)
const HEARTRAILS = 'https://express.heartrails.com/api/json'
const TOKENS = 'https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main/tokens.txt'
const UA = { 'User-Agent': 'train-jp-build (https://github.com/ymkthr/train-jp)' }

async function cached(file, get) {
  const path = `${WORK}/${file}`
  try {
    return await readFile(path, 'utf8')
  } catch {
    const text = await get()
    await writeFile(path, text)
    return text
  }
}

async function fetchText(url, init) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...init?.headers } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

const heartrails = async params => JSON.parse(await fetchText(`${HEARTRAILS}?${new URLSearchParams(params)}`)).response

async function mapLimit(items, n, f) {
  const out = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i])
    }
  }
  await Promise.all(Array.from({ length: n }, worker))
  return out
}

async function heartrailsRows() {
  const { prefecture } = await heartrails({ method: 'getPrefectures' })
  const lines = new Set((await mapLimit(prefecture, 4, p => heartrails({ method: 'getLines', prefecture: p }))).flatMap(r => r.line))
  const stations = await mapLimit([...lines], 4, line => heartrails({ method: 'getStations', line }))
  return JSON.stringify(stations.flatMap(r => r.station.map(({ name, prefecture, line, x, y }) => ({ name, prefecture, line, x, y }))))
}

const SPARQL = `SELECT ?label ?kana ?coord WHERE {
  ?item wdt:P31/wdt:P279* wd:Q55488; wdt:P17 wd:Q17; rdfs:label ?label.
  FILTER(lang(?label) = "ja")
  OPTIONAL { ?item wdt:P1814 ?kana }
  OPTIONAL { ?item wdt:P625 ?coord }
}`

async function wikidata() {
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query: SPARQL })}`
  return fetchText(url, { headers: { Accept: 'application/sparql-results+json' } })
}

await mkdir(WORK, { recursive: true })
const rows = JSON.parse(await cached('heartrails-stations.json', heartrailsRows))
const wd = JSON.parse(await cached('wikidata-kana-coord.json', wikidata)).results.bindings.map(b => {
  const [lon, lat] = b.coord?.value.match(/^Point\(([-\d.]+) ([-\d.]+)\)$/)?.slice(1).map(Number) ?? []
  return { label: b.label.value, kana: b.kana?.value, lat, lon }
})
const vocab = new Set((await cached('tokens.txt', () => fetchText(TOKENS))).split('\n').map(l => l.split('\t')[0]))

// HeartRails は同じ駅を路線ごとに1行ずつ返すので、同じ名前で 3km 以内の行を1駅にまとめる（乗換駅は路線ごとに座標が少しずれる）。
// 高松（香川県）と高松（東京都）のように離れた同名の駅は別の駅として残す。
const km = (a, b) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111
const byName = new Map()
for (const r of rows) {
  const at = { lat: r.y, lon: r.x }
  const same = byName.get(r.name) ?? []
  const place = same.find(p => km(p, at) < 3)
  if (!place) same.push({ name: r.name, pref: r.prefecture, lines: [r.line], ...at })
  else if (!place.lines.includes(r.line)) place.lines.push(r.line)
  byName.set(r.name, same)
}
// 候補を並べるときに乗換の多い駅を先にするため、路線の多い順に並べて書き出す。
const places = [...byName.values()].flat().toSorted((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name, 'ja'))
const names = [...byName.keys()]

// Wikidata のラベルは「村上駅 (千葉県)」のように同名の駅を後ろの括弧で分けるので、それと「駅」を外して HeartRails の駅名に合わせる。
// 「西鉄福岡（天神）」のように括弧も駅名のうちの駅があるので、括弧を残した形で引けなければ括弧を外して引く。「ヶ」と「ケ」の違いは無視する。
// 同名の駅は座標で見分け、10km 以内の項目の読みを使う。近くに無ければ座標の無い項目の読みを使い、それも無ければ Wikidata には無いものとする
// （府中は東京都では「ふちゅう」、徳島県では「こう」なので、遠くの同名の駅の読みは使わない）。
const SUFFIX = { 駅: 'えき', 停留場: 'ていりゅうじょう', 停留所: 'ていりゅうしょ' }
const key = s => s.normalize('NFKC').replaceAll('ヶ', 'ケ').replaceAll('ヵ', 'カ')
const bare = s => s.replace(/\([^)]*\)/g, '')
const exact = new Map()
const loose = new Map()
const add = (map, k, entry) => map.set(k, [...(map.get(k) ?? []), entry])
for (const { label, kana, lat, lon } of wd) {
  if (!kana) continue
  const [, name, suffix] = key(label).replace(/\s*\([^)]*\)$/, '').match(/^(.+?)(駅|停留場|停留所)?$/)
  let k = hiragana(kana.normalize('NFKC').replace(/\s/g, ''))
  if (suffix && k.endsWith(SUFFIX[suffix])) k = k.slice(0, -SUFFIX[suffix].length)
  add(exact, name, { kana: k, lat, lon })
  add(loose, bare(name), { kana: k, lat, lon })
}
function wikidataReadings(place) {
  const entries = exact.get(key(place.name)) ?? loose.get(bare(key(place.name))) ?? []
  const near = entries.filter(e => e.lat !== undefined && km(e, place) < 10)
  return [...new Set((near.length ? near : entries.filter(e => e.lat === undefined)).map(e => e.kana))]
}

// Wikidata に読みが無い駅は、日本語版 Wikipedia の冒頭「十弗駅（とおふつえき）は、…」から読みを取る。20 記事ずつ引く。
// 転送先が別の駅の記事（松山駅前駅 → 松山駅）なら使わない。
async function wikipediaReadings(batch) {
  const params = { action: 'query', prop: 'extracts', exintro: 1, explaintext: 1, exlimit: 20, redirects: 1, format: 'json', formatversion: 2 }
  const { query } = JSON.parse(await fetchText(`https://ja.wikipedia.org/w/api.php?${new URLSearchParams({ ...params, titles: batch.map(n => `${n}駅`).join('|') })}`))
  const moved = new Map([...(query.normalized ?? []), ...(query.redirects ?? [])].map(r => [r.from, r.to]))
  const extracts = new Map(query.pages.map(p => [p.title, p.extract]))
  return batch.map(n => {
    let title = `${n}駅`
    while (moved.has(title)) title = moved.get(title)
    if (key(title.replace(/\s*\([^)]*\)$/, '')) !== key(`${n}駅`)) return [n, null]
    return [n, extracts.get(title)?.match(/^[^（(]*[（(]\s*([ぁ-ゖー]+?)えき/)?.[1] ?? null]
  })
}

// モデルは数字を出さない（tokens.txt に無い）ので漢数字にする。英字は1文字ずつのトークンがあるのでそのまま残し、読みのカタカナも足す。
const DIGITS = '〇一二三四五六七八九'
const kanjiNumber = n =>
  [[1000, '千'], [100, '百'], [10, '十']].map(([u, c]) => {
    const d = Math.floor(n / u) % 10
    return d ? (d > 1 ? DIGITS[d] : '') + c : ''
  }).join('') + (n % 10 ? DIGITS[n % 10] : '') || DIGITS[0]
const writable = w => [...w].every(c => vocab.has(c))

function spokenForms(name) {
  const out = new Set()
  // 「八幡大橋（東陵高校）」は括弧の中を言わない形と、続けて言う形の両方にする。
  for (const form of new Set([name.replace(/（[^）]*）/g, ''), name.replace(/[（）]/g, '')])) {
    const w = form.replace(/\d+/g, d => kanjiNumber(Number(d)))
    for (const v of [w, w.replace(/[A-Za-z]/g, c => LETTERS[c.toUpperCase()])]) {
      out.add(v)
      out.add(v.replaceAll('・', ''))
    }
  }
  return [...out]
}

const forms = new Map(names.map(n => [n, spokenForms(n)]))
const noWikidata = [...new Set(places.filter(p => !wikidataReadings(p).length).map(p => p.name))]
const batches = Array.from({ length: Math.ceil(noWikidata.length / 20) }, (_, i) => noWikidata.slice(i * 20, i * 20 + 20))
const wikipedia = JSON.parse(await cached('wikipedia.json', async () => JSON.stringify(Object.fromEntries((await mapLimit(batches, 4, wikipediaReadings)).flat()))))

// モデルは知らない漢字の所をかなで書く（椥辻 →「ナギ辻」「なぎ辻」）ので、その字だけひらがな・カタカナにした別名も作る。
// 字の読みは手で持ち、駅名全体の読みの同じ位置（先頭・末尾・途中）に現れるときだけ使う。
// ponytail: 字の読みは手書きの表。データを取り直して新しい字が出たら、下の警告を見て足す。
const KANJI_KANA = { 杁: 'いり', 椥: 'なぎ', 弗: 'ふつ', 艫: 'へ', 驫: 'とどろ', 擶: 'たま' }
const katakana = s => s.replace(/[ぁ-ゔ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
function partlyKana(form, readings) {
  const chars = [...form]
  const out = chars.map((c, i) => {
    if (vocab.has(c)) return c
    const at = i === 0 ? 'startsWith' : i === chars.length - 1 ? 'endsWith' : 'includes'
    return KANJI_KANA[c] && readings.some(r => r[at](KANJI_KANA[c])) ? KANJI_KANA[c] : null
  })
  if (out.includes(null)) return []
  return [out.join(''), out.map((s, i) => (s === chars[i] ? s : katakana(s))).join('')]
}

const source = { wikidata: 0, wikipedia: 0, kuromoji: 0 }
const warned = new Set()
const stations = []
for (const p of places) {
  const fromWikidata = wikidataReadings(p)
  const kana = fromWikidata.length ? fromWikidata : wikipedia[p.name] ? [wikipedia[p.name]] : [await reading(forms.get(p.name)[0])]
  source[fromWikidata.length ? 'wikidata' : wikipedia[p.name] ? 'wikipedia' : 'kuromoji']++
  // tokens.txt に無い漢字を含む駅は、駅名全体をひらがなの読みでも hotwords に登録する。
  let aliases = forms.get(p.name)
  if (!aliases.every(writable)) {
    const partial = aliases.flatMap(f => partlyKana(f, kana))
    if (!partial.some(writable) && !warned.has(p.name)) console.warn(`${p.name}: KANJI_KANA に字の読みが無いか、駅名の読み（${kana.join('、')}）と合わない`)
    warned.add(p.name)
    aliases = [...new Set([...aliases, ...partial, ...kana])].filter(w => w && writable(w))
  }
  stations.push({ name: p.name, pref: p.pref, line: p.lines[0], lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), kana, aliases })
}
await writeFile(OUT, `[\n${stations.map(s => JSON.stringify(s)).join(',\n')}\n]\n`)

const unmatched = places.filter(p => !wikidataReadings(p).length).map(p => `${p.name}\t${p.pref}`)
await writeFile(`${WORK}/unmatched.txt`, unmatched.join('\n'))
const sameName = [...byName.values()].filter(s => s.length > 1).length
console.log(`${rows.length} 行を ${stations.length} 駅にまとめた（駅名は ${names.length}、別の場所に同名の駅がある駅名 ${sameName}）`)
console.log(`読み: Wikidata ${source.wikidata}、Wikipedia ${source.wikipedia}、kuromoji ${source.kuromoji}。Wikidata で取れなかった駅は ${WORK}/unmatched.txt`)
// 駅名をそのままでは hotwords にできない駅（数字、英字の続き、tokens.txt に無い漢字、括弧）を何で登録したか。
const special = stations.filter(s => !writable(s.name) || /[A-Za-z]{2}|（/.test(s.name))
console.log(`そのままでは登録できない駅 ${special.length}、うち別名で登録できた駅 ${special.filter(s => s.aliases.length).length}`)
for (const s of special) console.log(`${s.name}（${s.pref}） → ${s.aliases.join(' / ') || '（登録できない）'}`)
