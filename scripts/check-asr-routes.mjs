// 「○○から××まで」の音声を public/sherpa の WASM で認識し、resolveRoute で駅の候補に戻るかを確かめる。
// 使い方:
//   node scripts/check-asr-routes.mjs --list               音声のファイル名と読み上げる文を出す（TTS に渡す）
//   node scripts/check-asr-routes.mjs <モデル> <音声>       モデルは tokens.txt などのあるディレクトリ、
//                                                           音声は <出発>_<到着>.wav（16kHz mono 16bit）のあるディレクトリ
// hotwords なしと、stations.json の全別名を hotwords にした場合の両方で認識する。
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRecognizer, s16leToFloat32 } from '../src/asr/recognizer.ts'
import { STATIONS, resolveRoute } from '../src/asr/stations.ts'

// 読みを確かにするため、読み上げる文はかなで書く。そのままでは hotwords にできない駅を1つずつ、主要駅と組にする。
const CASES = [
  ['北12条', '札幌', 'きたじゅうにじょうから、さっぽろまで'],
  ['すすきの', '西11丁目', 'すすきのから、にしじゅういっちょうめまで'],
  ['南郷13丁目', '札幌', 'なんごうじゅうさんちょうめから、さっぽろまで'],
  ['札幌', '西線16条', 'さっぽろから、にしせんじゅうろくじょうまで'],
  ['羽田空港第1ターミナル', '浜松町', 'はねだくうこうだいいちターミナルから、はままつちょうまで'],
  ['上野', '空港第2ビル', 'うえのから、くうこうだいにビルまで'],
  ['JR難波', '天王寺', 'ジェイアールなんばから、てんのうじまで'],
  ['京橋', 'JR野江', 'きょうばしから、ジェイアールのえまで'],
  ['YRP野比', '横浜', 'ワイアールピーのびから、よこはままで'],
  ['広島', 'JA広島病院前', 'ひろしまから、ジェイエーひろしまびょういんまえまで'],
  ['杁ヶ池公園', '名古屋', 'いりがいけこうえんから、なごやまで'],
  ['名古屋', '二ツ杁', 'なごやから、ふたついりまで'],
  ['椥辻', '京都', 'なぎつじから、きょうとまで'],
  ['十弗', '帯広', 'とおふつから、おびひろまで'],
  ['艫作', '弘前', 'へなしから、ひろさきまで'],
  ['青森', '驫木', 'あおもりから、とどろきまで'],
  ['高擶', '山形', 'たかたまから、やまがたまで'],
  ['西鉄福岡（天神）', '博多', 'にしてつふくおかてんじんから、はかたまで'],
  ['東京', '箱根湯本', 'とうきょうから、はこねゆもとまで'],
  ['北千住', '大手町', 'きたせんじゅから、おおてまちまで'],
  ['新宿', '横浜', 'しんじゅくから、よこはままで'],
  ['大阪', '京都', 'おおさかから、きょうとまで'],
]
if (process.argv[2] === '--list') {
  for (const [from, to, say] of CASES) console.log(`${from}_${to}.wav\t${say}`)
  process.exit()
}
const [modelDir, audioDir] = process.argv.slice(2)
if (!audioDir) throw new Error('使い方: node scripts/check-asr-routes.mjs <モデル> <音声>')

// recognizer.ts はブラウザ用なので、document.baseURI と file: の fetch だけ用意して Node で動かす。
globalThis.document = { baseURI: pathToFileURL(fileURLToPath(new URL('../public/', import.meta.url))).href }
const browserFetch = globalThis.fetch
globalThis.fetch = async (url, init) =>
  String(url).startsWith('file:')
    ? new Response(await readFile(new URL(url)), { headers: { 'Content-Type': 'application/wasm' } })
    : browserFetch(url, init)

const loadModel = async () => {
  const [encoder, decoder, joiner, tokens] = await Promise.all(
    ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt'].map(f =>
      readFile(`${modelDir}/${f}`),
    ),
  )
  return { encoder, decoder, joiner, tokens }
}

// WAV の data チャンクを探す。ffmpeg は fmt と data の間に LIST を入れることがある。
function wavSamples(buf) {
  for (let at = 12; at < buf.length; ) {
    const size = buf.readUInt32LE(at + 4)
    if (buf.toString('ascii', at, at + 4) === 'data') return s16leToFloat32(buf.subarray(at + 8, at + 8 + size))
    at += 8 + size + (size & 1)
  }
  throw new Error('data チャンクがありません')
}

const hotwords = [...new Set(STATIONS.flatMap(s => s.aliases))]
const plain = await createRecognizer(await loadModel(), [])
const boosted = await createRecognizer(await loadModel(), hotwords)
console.log(`hotwords ${hotwords.length} 語`)
console.log('| 発話 | hotwords なし | 全駅 hotwords | 出発の候補 | 到着の候補 | 正誤 |')
console.log('|---|---|---|---|---|---|')
// ○: 正解の駅に確定、△: 正解を含む候補から選ぶ、×: 正解が候補に無いか引けない
const grade = (c, want) => (!c?.stations.some(s => s.name === want) ? '×' : c.sure && c.stations.length === 1 ? '○' : '△')
const shown = c => (c ? `${c.stations.map(s => `${s.name}（${s.pref}）`).join('、') || 'なし'}${c.sure ? '' : '（あいまい）'}` : 'null')
let ok = 0
for (const [from, to, say] of CASES) {
  const pcm = wavSamples(await readFile(`${audioDir}/${from}_${to}.wav`))
  const text = boosted.recognize(pcm)
  const route = await resolveRoute(text)
  const marks = [grade(route?.from, from), grade(route?.to, to)]
  const mark = marks.includes('×') ? '×' : marks.includes('△') ? '△' : '○'
  ok += mark === '×' ? 0 : 1
  console.log(`| ${say} | ${plain.recognize(pcm)} | ${text} | ${shown(route?.from)} | ${shown(route?.to)} | ${mark} |`)
}
console.log(`正解を候補に含む ${ok}/${CASES.length}`)
