import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AppLocationAccuracy,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { REAZONSPEECH_K2_V2, createRecognizer, evenStore, loadModel, transcribe, type Recognizer, type Transcription } from 'even-g2-asr'
import { version } from '../app.json'
import { loadReading } from './asr/reading'
import { STATIONS, resolveRoute, resolveStation, type Candidates, type Station } from './asr/stations'
import { searchJourneys, type Journey, type JourneyPage } from './journey'
import { ON_TIME, expected, observe, type Lag } from './progress'
import { BODY_W, CLOCK_W, HEADER_W, LEVEL_BARS, LIST_W, NOTICE_BORDER, NOTICE_H, NOTICE_MS, NOTICE_PAD, NOTICE_W, TIME_W, alighting, clock, heardRoute, journeyItems, lastLines, levelBar, notice, overview, route, routeLabel, searching, stationItem, stops, strip, type Columns } from './screens'

type Route = { from: Candidates; to: Candidates }

type List = { kind: 'list'; from: Station; to: Station } & JourneyPage

/**
 * 音声入力の画面。声の大きさと途中経過が届くたびに書き換え、画面は組み直さずに文字だけを差し替える。
 * listening は録音中、finishing は録音が止まって確定を待つ間、heard は確定した文字を見せている間。
 */
type Voice = {
  kind: 'voice'
  transcription: Promise<Transcription>
  phase: 'listening' | 'finishing' | 'heard'
  /** 届いた音声の区間（約 0.1 秒）ごとの RMS。新しいものが後ろで、棒に出す分だけ持つ。 */
  levels: number[]
  text: string
  route: Route | null
}

type Screen =
  | { kind: 'idle'; message?: string }
  | Voice
  | { kind: 'searching'; from: Station; to: Station; since: number }
  | { kind: 'pick'; side: 'from' | 'to'; route: Route }
  | List
  | { kind: 'strip' | 'overview' | 'stops'; journey: Journey; list: List }

/** 音声認識の準備の進み具合。モデルの復元・ダウンロードと認識器の作成は起動時に裏で進める。 */
type Asr =
  | { kind: 'loading'; step: 'restore' | 'download' | 'create'; percent: number }
  | { kind: 'ready'; recognizer: Recognizer }
  | { kind: 'failed'; reason: string }

const NEXT_ON_TAP = { overview: 'strip', strip: 'stops', stops: 'overview' } as const

const bridge = await waitForEvenAppBridge()
let screen: Screen = { kind: 'idle' }
let asr: Asr = { kind: 'loading', step: 'restore', percent: 0 }
let lag: Lag = ON_TIME
/** 最後に知らせた区間と、その知らせを閉じる時刻。区間ごとに1回だけ出す。 */
let noticed = { leg: -1, until: 0 }
// 検索中の電車。updateImageRawData は PNG をそのまま受け取り、グラス側で 4bit グレースケールにする。
const TRAIN = new Uint8Array(await (await fetch(new URL('train.png', document.baseURI))).arrayBuffer())
const TRAIN_W = 288
const TRAIN_H = 144

const text = (id: number, name: string, content: string, box: [number, number, number, number], capture = 0) =>
  new TextContainerProperty({
    xPosition: box[0], yPosition: box[1], width: box[2], height: box[3],
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: id, containerName: name, content, isEventCapture: capture,
  })

const HEADER_H = 30
const COL_Y = HEADER_H
const COL_H = 288 - HEADER_H
const CLOCK_ID = 4
const NOTICE_ID = 5
const CLOSING_ID = 6
const NOTICE_X = (576 - NOTICE_W) / 2
const NOTICE_Y = (288 - NOTICE_H) / 2
// 帯の枠の内側で、文言の3行の下に置く。
const CLOSING_BOX: [number, number, number, number] = [NOTICE_X + NOTICE_BORDER + NOTICE_PAD, NOTICE_Y + NOTICE_BORDER + NOTICE_PAD + 3 * 28, NOTICE_W - 2 * (NOTICE_BORDER + NOTICE_PAD), 28]
const DIM = 2

const noticeText = (s: Screen, now: Date) =>
  'journey' in s && now.getTime() < noticed.until ? notice(expected(s.journey, lag), noticed.leg, noticed.until, now) : null

function columnsPage(c: Columns) {
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, 'header', c.header, [0, 0, HEADER_W, HEADER_H]),
      text(2, 'times', c.times, [0, COL_Y, TIME_W, COL_H]),
      text(3, 'body', c.body, [TIME_W, COL_Y, BODY_W, COL_H], 1),
    ],
  }
}

const list = (id: number, name: string, items: string[], y = 0, width = 576) =>
  new ListContainerProperty({
    xPosition: 0, yPosition: y, width, height: 288 - y,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: id, containerName: name, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items }),
  })

const voiceStatus = () =>
  asr.kind === 'failed'
    ? `音声認識を使えません（${asr.reason}）`
    : asr.kind === 'loading'
      ? `音声認識を準備中${asr.step === 'create' ? '' : ` ${asr.percent}%`}${asr.step === 'download' ? '（初回のみダウンロード）' : ''}`
      : null

/** 待ち受けの文字。音声認識の準備が進むと変わるので、時計と一緒に書き換える。 */
const idleText = (message?: string) =>
  [message, voiceStatus() ?? 'タップして「△△駅から××駅まで」と話す', 'スマホで入力しても検索できます'].filter(Boolean).join('\n')

const MSG_BOX: [number, number, number, number] = [0, HEADER_H, 576, 288 - HEADER_H]

// 1行は 27px。4行で全角 28 字ずつ、約 110 字まで見せる。
const VOICE_LINES = 4
const VOICE_TEXT_BOX: [number, number, number, number] = [0, HEADER_H + 10, 576, VOICE_LINES * 27]
const VOICE_ROUTE_BOX: [number, number, number, number] = [0, VOICE_TEXT_BOX[1] + VOICE_TEXT_BOX[3] + 14, 576, 30]
const VOICE_HINT_BOX: [number, number, number, number] = [0, 288 - 30, 576, 30]
// 5 と 6 は降りる駅の知らせの容器。tick は 5 があるかで知らせを出しているかを見分けるので、使わない。
const VOICE_HINT_ID = 7
const VOICE_HEAD = { finishing: '文字にしています…', heard: '聞き取りました' }

/** 音声入力の画面の文字。容器の ID と名前と中身。 */
function voiceTexts(v: Voice): [number, string, string][] {
  return [
    [1, 'head', v.phase === 'listening' ? `${levelBar(v.levels)}  聞いています` : VOICE_HEAD[v.phase]],
    [2, 'heard', lastLines(v.text, VOICE_LINES) || ' '],
    [3, 'route', v.route ? heardRoute(v.route.from, v.route.to) : ' '],
    [VOICE_HINT_ID, 'hint', v.phase === 'listening' ? 'タップで終了　ダブルタップで取り消し' : ' '],
  ]
}

function page(s: Screen, now: Date) {
  switch (s.kind) {
    case 'idle': {
      // グラスに入っている版を見分けるため。Even Hub に届く版は app.json のもの。
      const label = `v${version}`
      const w = getTextWidth(label) + 8
      return {
        containerTotalNum: 2,
        textObject: [
          text(1, 'msg', idleText(s.message), MSG_BOX, 1),
          new TextContainerProperty({ ...text(2, 'version', label, [576 - w, 288 - 28, w, 28]), textColor: DIM }),
        ],
      }
    }
    case 'voice': {
      const [head, heard, found, hint] = voiceTexts(s)
      return {
        containerTotalNum: 4,
        textObject: [
          text(...head, [0, 0, HEADER_W, HEADER_H]),
          text(...heard, VOICE_TEXT_BOX, 1),
          text(...found, VOICE_ROUTE_BOX),
          new TextContainerProperty({ ...text(...hint, VOICE_HINT_BOX), textColor: DIM }),
        ],
      }
    }
    case 'searching':
      // 画像コンテナは入力を受けられないので、全面の空の文字コンテナに受けさせる。
      return {
        containerTotalNum: 3,
        textObject: [
          text(1, 'capture', ' ', [0, 0, 576, 288], 1),
          text(2, 'searching', searching(s.from, s.to, 0), [0, 30 + TRAIN_H + 10, 576, 288 - (30 + TRAIN_H + 10)]),
        ],
        imageObject: [
          new ImageContainerProperty({ xPosition: (576 - TRAIN_W) / 2, yPosition: 30, width: TRAIN_W, height: TRAIN_H, containerID: 3, containerName: 'train' }),
        ],
      }
    case 'pick':
      return {
        containerTotalNum: 2,
        textObject: [text(1, 'title', s.side === 'from' ? '出発駅を選択' : '到着駅を選択', [0, 0, HEADER_W, HEADER_H])],
        listObject: [list(2, 'stations', s.route[s.side].stations.map(stationItem), HEADER_H)],
      }
    case 'list':
      return {
        containerTotalNum: 2,
        textObject: [text(1, 'route', route(s.from.name, s.to.name), [LIST_W, 100, 576 - LIST_W, 100])],
        listObject: [list(2, 'journeys', journeyItems(s.journeys), 0, LIST_W)],
      }
    case 'strip':
      return { containerTotalNum: 1, textObject: [text(1, 'strip', strip(expected(s.journey, lag), now), [0, 288 - 60, 576, 60], 1)] }
    case 'overview':
      return columnsPage(overview(s.journey))
    case 'stops':
      return columnsPage(stops(expected(s.journey, lag), now))
  }
}

let started = false
/** グラスに今出ている文字。差分だけ送るために持つ。 */
const sent = new Map<number, string>()
async function show(next: Screen) {
  if ('journey' in screen && !('journey' in next)) bridge.stopAppLocationUpdates().catch(() => {})
  screen = next
  const now = new Date()
  const p = page(next, now)
  const banner = noticeText(next, now)
  // 文字の容器には背景が無く、重ねると下の文字が透ける。帯を出す間は、帯と時計だけにする。
  const textObject = [
    ...(banner === null
      ? p.textObject
      : [
          new TextContainerProperty({ ...text(NOTICE_ID, 'notice', banner.body, [NOTICE_X, NOTICE_Y, NOTICE_W, NOTICE_H], 1), borderWidth: NOTICE_BORDER, borderColor: 15, borderRadius: 6, paddingLength: NOTICE_PAD }),
          new TextContainerProperty({ ...text(CLOSING_ID, 'closing', banner.closing, CLOSING_BOX), textColor: DIM }),
        ]),
    text(CLOCK_ID, 'clock', clock(now), [HEADER_W, 0, CLOCK_W, HEADER_H]),
  ]
  const full = { ...p, containerTotalNum: p.containerTotalNum + textObject.length - p.textObject.length, textObject }
  sent.clear()
  for (const t of textObject) sent.set(t.containerID!, t.content!)
  if (started) await bridge.rebuildPageContainer(new RebuildPageContainer(full))
  else {
    started = true
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(full))
  }
  if (next.kind === 'searching') await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 3, containerName: 'train', imageData: TRAIN }))
}

// 時計・「あと N 分」・現在の駅・検索の秒数は時刻で変わるので、レイアウトは保ったまま文字だけ差し替える。
function live(s: Screen, now: Date): [number, string, string][] {
  const time: [number, string, string] = [CLOCK_ID, 'clock', clock(now)]
  switch (s.kind) {
    case 'strip':
      return [time, [1, 'strip', strip(expected(s.journey, lag), now)]]
    case 'stops':
      return [time, ...Object.entries(stops(expected(s.journey, lag), now)).map(([k, v], i): [number, string, string] => [i + 1, k, v])]
    case 'searching':
      return [time, [2, 'searching', searching(s.from, s.to, Math.round((now.getTime() - s.since) / 1000))]]
    case 'idle':
      return [time, [1, 'msg', idleText(s.message)]]
    case 'voice':
      return [time, ...voiceTexts(s)]
    default:
      return [time]
  }
}

/** 時刻や声で変わる文字をグラスに送る。tick と hear の両方から呼ぶので、前の呼び出しが送り終えてから始める。 */
let pushing = Promise.resolve()
const push = () => (pushing = pushing.then(update, update))

async function update() {
  const s = screen
  const now = new Date()
  if ('journey' in s) {
    const leg = alighting(expected(s.journey, lag), now)
    if (leg !== null && leg !== noticed.leg) noticed = { leg, until: now.getTime() + NOTICE_MS }
  }
  // 帯は出し始めと閉じる時に容器が変わるので、画面を組み直す。
  const banner = noticeText(s, now)
  if ((banner !== null) !== sent.has(NOTICE_ID)) return await show(s)
  const updates: [number, string, string][] =
    banner === null ? live(s, now) : [[CLOCK_ID, 'clock', clock(now)], [NOTICE_ID, 'notice', banner.body], [CLOSING_ID, 'closing', banner.closing]]
  for (const [containerID, containerName, content] of updates) {
    // 送っている間に画面が組み直されたら、古い画面の文字を新しい画面に書かない。
    if (s !== screen) break
    if (sent.get(containerID) === content) continue
    sent.set(containerID, content)
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content }))
  }
}

// 声の棒と途中経過は 0.3 秒ごとに送る。BLE で無理なく送れる間隔で、途中経過が届いてから出るまでの待ちもこの程度に収まる。
const VOICE_TICK_MS = 300

// ふだんは秒の変わり目に合わせる。転送が間隔を超えても重ならないよう、送り終えてから次を予約する。
async function tick() {
  try {
    await push()
  } finally {
    setTimeout(tick, screen.kind === 'voice' ? VOICE_TICK_MS : 1000 - (Date.now() % 1000))
  }
}

// CLICK_EVENT は 0 なので protobuf 上は省略され、eventType が undefined で届く。
const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? (e.eventType ?? OsEventTypeList.CLICK_EVENT) : null)

bridge.onEvenHubEvent(event => {
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    if (screen.kind === 'pick') show({ kind: 'idle' })
    else if (screen.kind === 'voice') screen.transcription.then(t => t.cancel(), () => {})
    else if (screen.kind === 'list' || screen.kind === 'idle' || screen.kind === 'searching') bridge.shutDownPageContainer(1)
    else if ('journey' in screen) show(screen.list)
    return
  }
  if (!types.includes(OsEventTypeList.CLICK_EVENT)) return
  const index = event.listEvent?.currentSelectItemIndex ?? 0
  if (screen.kind === 'idle') {
    if (asr.kind === 'ready') hear(asr.recognizer)
    else show({ kind: 'idle', message: asr.kind === 'failed' ? 'スマホで入力してください' : '音声認識の準備ができるまでお待ちください' })
  } else if (screen.kind === 'voice') {
    if (screen.phase === 'listening') screen.phase = 'finishing'
    screen.transcription.then(t => t.stop(), () => {})
  } else if (screen.kind === 'pick') {
    const station = screen.route[screen.side].stations[index]
    if (station) go({ ...screen.route, [screen.side]: { stations: [station], sure: true } })
  } else if (screen.kind === 'list') {
    if (index === 0) search(screen.from, screen.to, screen.earlier)
    else if (index === screen.journeys.length + 1) search(screen.from, screen.to, screen.later)
    else {
      lag = ON_TIME
      noticed = { leg: -1, until: 0 }
      // 間隔を詰めないと、30 秒ほどの停車の間に位置が届かず駅を取りこぼす。
      // 位置を返さない環境（シミュレータ、権限の拒否）では時刻だけで進めばよいので、失敗は捨てる。
      bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 5000 }).catch(() => {})
      show({ kind: 'overview', journey: screen.journeys[index - 1], list: screen })
    }
  } else if ('journey' in screen) {
    show({ ...screen, kind: NEXT_ON_TAP[screen.kind] })
  }
})

bridge.onAppLocationChanged(fix => {
  if ('journey' in screen) lag = observe(screen.journey, lag, fix, new Date())
})

const form = document.querySelector<HTMLFormElement>('#search')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const voice = document.querySelector<HTMLParagraphElement>('#voice')!
const heardText = document.querySelector<HTMLParagraphElement>('#heard')!

// TypeScript は await を挟んでも screen の絞り込みを保つので、比べるたびに今の値を読み直す。
const showing = (s: Screen) => screen === s

/** 確定した文字と引けた駅を、検索や駅の選択に進む前にグラスに出しておく長さ。 */
const HEARD_MS = 500

// スマホの画面にも、グラスと同じ途中経過と引けた駅を出す。
const mirror = (v: Voice) => {
  heardText.textContent = [v.text, v.route && routeLabel(v.route.from, v.route.to)].filter(Boolean).join('\n')
}

/**
 * 録音しながら途中経過をグラスとスマホに出し、確定した文字から駅が引ければ go に渡す。
 * 録音中・認識中にスマホから検索されたら画面はそちらに移っているので、この後は何もしない。
 * 録音は無音が続いても止まるので、タップでの終了を待たずに確定へ進むことがある。
 */
async function hear(recognizer: Recognizer) {
  // 途中経過から駅を引くのは、引いている間に変わった文字のうち最後のものだけ。resolveRoute は 20〜60ms かかるので、毎回は引かない。
  let resolving = false
  let resolved = ''
  const preview = async () => {
    if (resolving) return
    resolving = true
    try {
      while (resolved !== voiceInput.text) {
        const t = voiceInput.text
        const r = await resolveRoute(t)
        if (voiceInput.phase === 'heard') return
        voiceInput.route = r
        resolved = t
        mirror(voiceInput)
      }
    } finally {
      resolving = false
    }
  }
  const voiceInput: Voice = {
    kind: 'voice',
    phase: 'listening',
    levels: [],
    text: '',
    route: null,
    transcription: transcribe(bridge, recognizer, {
      onLevel: rms => {
        voiceInput.levels.push(rms)
        if (voiceInput.levels.length > LEVEL_BARS) voiceInput.levels.shift()
      },
      onPartial: text => {
        voiceInput.text = text
        mirror(voiceInput)
        // 引けなかった理由は、確定した文字で引き直すときに出す。
        preview().catch(() => {})
      },
      onStop: () => {
        voiceInput.phase = 'finishing'
      },
    }),
  }
  mirror(voiceInput)
  try {
    const [, transcription] = await Promise.all([show(voiceInput), voiceInput.transcription])
    const heard = await transcription.final
    if (!showing(voiceInput)) return
    if (heard === null) {
      heardText.textContent = ''
      return await show({ kind: 'idle' })
    }
    const route = heard === resolved ? voiceInput.route : heard ? await resolveRoute(heard) : null
    if (!showing(voiceInput)) return
    if (!route) return await show({ kind: 'idle', message: heard ? `聞き取れませんでした「${heard}」` : '聞き取れませんでした' })
    voiceInput.phase = 'heard'
    voiceInput.text = heard
    voiceInput.route = route
    mirror(voiceInput)
    await push()
    await new Promise(r => setTimeout(r, HEARD_MS))
    if (showing(voiceInput)) await go(route)
  } catch (err) {
    if (showing(voiceInput)) await fail(err)
  }
}

// 失敗してもフォームからは探せるので、理由を出すだけにする。
async function prepareAsr() {
  const set = (next: Asr) => {
    asr = next
    voice.textContent = voiceStatus() ?? '音声入力: グラスをタップして「△△駅から××駅まで」と話す'
  }
  set(asr)
  try {
    const files = await loadModel(REAZONSPEECH_K2_V2, evenStore(bridge), p => {
      const percent = Math.floor((p.loaded / p.total) * 100)
      if (asr.kind === 'loading' && (asr.step !== p.phase || asr.percent !== percent)) set({ kind: 'loading', step: p.phase, percent })
    })
    set({ kind: 'loading', step: 'create', percent: 100 })
    const recognizer = await createRecognizer(files, [...new Set(STATIONS.flatMap(s => s.aliases))])
    // 話している途中から駅を引くので、録音を始める前に読みの辞書を読んでおく。読めなくても、駅を引くときに読み直す。
    await loadReading().catch(() => {})
    set({ kind: 'ready', recognizer })
  } catch (err) {
    set({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) })
  }
}

async function fail(err: unknown) {
  status.textContent = String(err instanceof Error ? err.message : err)
  await show({ kind: 'idle', message: status.textContent })
}

/** 音声でも入力でも、駅の候補が決まったらここに来る。決まっていない駅があれば出発駅、到着駅の順に選ばせ、両方決まったら経路を探す。 */
async function go(route: Route) {
  for (const side of ['from', 'to'] as const) {
    const c = route[side]
    if (c.sure && c.stations.length === 1) continue
    status.textContent = `グラスで${side === 'from' ? '出発駅' : '到着駅'}を選んでください`
    return show({ kind: 'pick', side, route })
  }
  await search(route.from.stations[0], route.to.stations[0])
}

async function search(from: Station, to: Station, cursor?: string) {
  status.textContent = '検索中…'
  // 画像の転送を待たずに検索を始める。結果の画面に切り替えるのは転送が終わってから。
  const shown = show({ kind: 'searching', from, to, since: Date.now() })
  try {
    const page = await searchJourneys(from, to, cursor)
    if (!page.journeys.length) throw new Error('経路が見つかりません')
    status.textContent = `${from.name} → ${to.name}: ${page.journeys.length}件`
    await shown
    await show({ kind: 'list', from, to, ...page })
  } catch (err) {
    await shown
    await fail(err)
  }
}

await show(screen)
tick()
prepareAsr()

form.addEventListener('submit', async e => {
  e.preventDefault()
  if (screen.kind === 'voice') screen.transcription.then(t => t.cancel(), () => {})
  const data = new FormData(form)
  const texts = [String(data.get('from')), String(data.get('to'))]
  try {
    const [from, to] = await Promise.all(texts.map(resolveStation))
    const missing = texts.find((_, i) => ![from, to][i].stations.length)
    if (missing) throw new Error(`駅が見つかりません: ${missing}`)
    await go({ from, to })
  } catch (err) {
    await fail(err)
  }
})
