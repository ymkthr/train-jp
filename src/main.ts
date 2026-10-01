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
import { resolveStation, type Candidates, type Station } from './asr/stations'
import { searchJourneys, type Journey, type JourneyPage } from './journey'
import { ON_TIME, expected, observe, type Lag } from './progress'
import { BODY_W, CLOCK_W, HEADER_W, LIST_W, TIME_W, clock, journeyItems, overview, route, searching, stationItem, stops, strip, type Columns } from './screens'

type Route = { from: Candidates; to: Candidates }

type List = { kind: 'list'; from: Station; to: Station } & JourneyPage

type Screen =
  | { kind: 'idle'; message: string }
  | { kind: 'searching'; from: Station; to: Station; since: number }
  | { kind: 'pick'; side: 'from' | 'to'; route: Route }
  | List
  | { kind: 'strip' | 'overview' | 'stops'; journey: Journey; list: List }

const NEXT_ON_TAP = { overview: 'strip', strip: 'stops', stops: 'overview' } as const
const WAITING = 'スマホで出発駅と到着駅を入力'

const bridge = await waitForEvenAppBridge()
let screen: Screen = { kind: 'idle', message: WAITING }
let lag: Lag = ON_TIME
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

function page(s: Screen, now: Date) {
  switch (s.kind) {
    case 'idle':
      return { containerTotalNum: 1, textObject: [text(1, 'msg', s.message, [0, HEADER_H, 576, 288 - HEADER_H], 1)] }
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
  const textObject = [...p.textObject, text(CLOCK_ID, 'clock', clock(now), [HEADER_W, 0, CLOCK_W, HEADER_H])]
  const full = { ...p, containerTotalNum: p.containerTotalNum + 1, textObject }
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
    default:
      return [time]
  }
}

// 秒の変わり目に合わせる。転送が 1 秒を超えても重ならないよう、送り終えてから次を予約する。
async function tick() {
  const s = screen
  try {
    for (const [containerID, containerName, content] of live(s, new Date())) {
      // 送っている間に画面が組み直されたら、古い画面の文字を新しい画面に書かない。
      if (s !== screen) break
      if (sent.get(containerID) === content) continue
      sent.set(containerID, content)
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content }))
    }
  } finally {
    setTimeout(tick, 1000 - (Date.now() % 1000))
  }
}

// CLICK_EVENT は 0 なので protobuf 上は省略され、eventType が undefined で届く。
const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? (e.eventType ?? OsEventTypeList.CLICK_EVENT) : null)

bridge.onEvenHubEvent(event => {
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    if (screen.kind === 'pick') show({ kind: 'idle', message: WAITING })
    else if (screen.kind === 'list' || screen.kind === 'idle' || screen.kind === 'searching') bridge.shutDownPageContainer(1)
    else show(screen.list)
    return
  }
  if (!types.includes(OsEventTypeList.CLICK_EVENT)) return
  const index = event.listEvent?.currentSelectItemIndex ?? 0
  if (screen.kind === 'pick') {
    const station = screen.route[screen.side].stations[index]
    if (station) go({ ...screen.route, [screen.side]: { stations: [station], sure: true } })
  } else if (screen.kind === 'list') {
    if (index === 0) search(screen.from, screen.to, screen.earlier)
    else if (index === screen.journeys.length + 1) search(screen.from, screen.to, screen.later)
    else {
      lag = ON_TIME
      // 間隔を詰めないと、30 秒ほどの停車の間に位置が届かず駅を取りこぼす。
      // 位置を返さない環境（シミュレータ、権限の拒否）では時刻だけで進めばよいので、失敗は捨てる。
      bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 5000 }).catch(() => {})
      show({ kind: 'overview', journey: screen.journeys[index - 1], list: screen })
    }
  } else if (screen.kind !== 'idle' && screen.kind !== 'searching') {
    show({ ...screen, kind: NEXT_ON_TAP[screen.kind] })
  }
})

bridge.onAppLocationChanged(fix => {
  if ('journey' in screen) lag = observe(screen.journey, lag, fix, new Date())
})

const form = document.querySelector<HTMLFormElement>('#search')!
const status = document.querySelector<HTMLParagraphElement>('#status')!

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

form.addEventListener('submit', async e => {
  e.preventDefault()
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
