import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { resolveStation, type Candidates, type Station } from './asr/stations'
import { searchJourneys, type Journey } from './journey'
import { BODY_W, TIME_W, listItem, overview, stationItem, stops, strip, type Columns } from './screens'

type Route = { from: Candidates; to: Candidates }

type Screen =
  | { kind: 'idle'; message: string }
  | { kind: 'pick'; side: 'from' | 'to'; route: Route }
  | { kind: 'list'; journeys: Journey[] }
  | { kind: 'strip' | 'overview' | 'stops'; journey: Journey; journeys: Journey[] }

const NEXT_ON_TAP = { overview: 'strip', strip: 'stops', stops: 'overview' } as const
const WAITING = 'スマホで出発駅と到着駅を入力'

const bridge = await waitForEvenAppBridge()
let screen: Screen = { kind: 'idle', message: WAITING }

const text = (id: number, name: string, content: string, box: [number, number, number, number], capture = 0) =>
  new TextContainerProperty({
    xPosition: box[0], yPosition: box[1], width: box[2], height: box[3],
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: id, containerName: name, content, isEventCapture: capture,
  })

const HEADER_H = 30
const COL_Y = HEADER_H
const COL_H = 288 - HEADER_H

function columnsPage(c: Columns) {
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, 'header', c.header, [0, 0, 576, HEADER_H]),
      text(2, 'times', c.times, [0, COL_Y, TIME_W, COL_H]),
      text(3, 'body', c.body, [TIME_W, COL_Y, BODY_W, COL_H], 1),
    ],
  }
}

const list = (id: number, name: string, items: string[], y = 0) =>
  new ListContainerProperty({
    xPosition: 0, yPosition: y, width: 576, height: 288 - y,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: id, containerName: name, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items }),
  })

function page(s: Screen, now: Date) {
  switch (s.kind) {
    case 'idle':
      return { containerTotalNum: 1, textObject: [text(1, 'msg', s.message, [0, 0, 576, 288], 1)] }
    case 'pick':
      return {
        containerTotalNum: 2,
        textObject: [text(1, 'title', s.side === 'from' ? '出発駅を選択' : '到着駅を選択', [0, 0, 576, HEADER_H])],
        listObject: [list(2, 'stations', s.route[s.side].stations.map(stationItem), HEADER_H)],
      }
    case 'list':
      return { containerTotalNum: 1, listObject: [list(1, 'journeys', s.journeys.map(listItem))] }
    case 'strip':
      return { containerTotalNum: 1, textObject: [text(1, 'strip', strip(s.journey, now), [0, 288 - 60, 576, 60], 1)] }
    case 'overview':
      return columnsPage(overview(s.journey))
    case 'stops':
      return columnsPage(stops(s.journey, now))
  }
}

let started = false
async function show(next: Screen) {
  screen = next
  const p = page(next, new Date())
  if (started) await bridge.rebuildPageContainer(new RebuildPageContainer(p))
  else {
    started = true
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(p))
  }
}

// 時刻が進むと「あと N 分」と現在の駅が変わるので、レイアウトは保ったまま文字だけ差し替える。
async function refresh() {
  const now = new Date()
  const updates =
    screen.kind === 'strip' ? [[1, 'strip', strip(screen.journey, now)]]
    : screen.kind === 'stops' ? Object.entries(stops(screen.journey, now)).map(([k, v], i) => [i + 1, k, v])
    : []
  for (const [containerID, containerName, content] of updates as [number, string, string][]) {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content }))
  }
}
setInterval(refresh, 20_000)

// CLICK_EVENT は 0 なので protobuf 上は省略され、eventType が undefined で届く。
const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? (e.eventType ?? OsEventTypeList.CLICK_EVENT) : null)

bridge.onEvenHubEvent(event => {
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    if (screen.kind === 'pick') show({ kind: 'idle', message: WAITING })
    else if (screen.kind === 'list' || screen.kind === 'idle') bridge.shutDownPageContainer(1)
    else show({ kind: 'list', journeys: screen.journeys })
    return
  }
  if (!types.includes(OsEventTypeList.CLICK_EVENT)) return
  const index = event.listEvent?.currentSelectItemIndex ?? 0
  if (screen.kind === 'pick') {
    const station = screen.route[screen.side].stations[index]
    if (station) go({ ...screen.route, [screen.side]: { stations: [station], sure: true } })
  } else if (screen.kind === 'list') {
    const journey = screen.journeys[index]
    if (journey) show({ kind: 'overview', journey, journeys: screen.journeys })
  } else if (screen.kind !== 'idle') {
    show({ ...screen, kind: NEXT_ON_TAP[screen.kind] })
  }
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

async function search(from: Station, to: Station) {
  status.textContent = '検索中…'
  try {
    const journeys = (await searchJourneys(from, to)).slice(0, 20)
    if (!journeys.length) throw new Error('経路が見つかりません')
    status.textContent = `${from.name} → ${to.name}: ${journeys.length}件`
    await show({ kind: 'list', journeys })
  } catch (err) {
    await fail(err)
  }
}

await show(screen)

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
