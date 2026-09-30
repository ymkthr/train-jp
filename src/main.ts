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
import { searchJourneys, type Journey } from './journey'
import { BODY_W, TIME_W, listItem, overview, stops, strip, type Columns } from './screens'

type Screen =
  | { kind: 'idle'; message: string }
  | { kind: 'list'; journeys: Journey[] }
  | { kind: 'strip' | 'overview' | 'stops'; journey: Journey; journeys: Journey[] }

const NEXT_ON_TAP = { strip: 'overview', overview: 'stops', stops: 'strip' } as const

const bridge = await waitForEvenAppBridge()
let screen: Screen = { kind: 'idle', message: 'スマホで出発駅と到着駅を入力' }

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

function page(s: Screen, now: Date) {
  switch (s.kind) {
    case 'idle':
      return { containerTotalNum: 1, textObject: [text(1, 'msg', s.message, [0, 0, 576, 288], 1)] }
    case 'list':
      return {
        containerTotalNum: 1,
        listObject: [
          new ListContainerProperty({
            xPosition: 0, yPosition: 0, width: 576, height: 288,
            borderWidth: 0, borderColor: 0, paddingLength: 0,
            containerID: 1, containerName: 'journeys', isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({
              itemCount: s.journeys.length, itemWidth: 0, isItemSelectBorderEn: 1,
              itemName: s.journeys.map(listItem),
            }),
          }),
        ],
      }
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
    if (screen.kind === 'list' || screen.kind === 'idle') bridge.shutDownPageContainer(1)
    else show({ kind: 'list', journeys: screen.journeys })
    return
  }
  if (!types.includes(OsEventTypeList.CLICK_EVENT)) return
  if (screen.kind === 'list') {
    const journey = screen.journeys[event.listEvent?.currentSelectItemIndex ?? 0]
    if (journey) show({ kind: 'strip', journey, journeys: screen.journeys })
  } else if (screen.kind !== 'idle') {
    show({ ...screen, kind: NEXT_ON_TAP[screen.kind] })
  }
})

await show(screen)

const form = document.querySelector<HTMLFormElement>('#search')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
form.addEventListener('submit', async e => {
  e.preventDefault()
  const data = new FormData(form)
  status.textContent = '検索中…'
  try {
    const journeys = (await searchJourneys(String(data.get('from')), String(data.get('to')))).slice(0, 20)
    if (!journeys.length) throw new Error('経路が見つかりません')
    status.textContent = `${journeys[0].from} → ${journeys[0].to}: ${journeys.length}件`
    await show({ kind: 'list', journeys })
  } catch (err) {
    status.textContent = String(err instanceof Error ? err.message : err)
    await show({ kind: 'idle', message: status.textContent })
  }
})
