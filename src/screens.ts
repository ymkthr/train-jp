import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import type { Candidates, Station } from './asr/stations'
import type { Journey, Leg, Stop } from './journey'

export const TIME_W = 64
export const BODY_W = 576 - TIME_W
export const ROWS = 9
export const LIST_W = 320
// 一番幅の広い「07:47:47」が 85px。
export const CLOCK_W = 90
export const HEADER_W = 576 - CLOCK_W

const hhmm = (d: Date) =>
  d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })

export const clock = (d: Date) =>
  d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Tokyo' })

const minutes = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60000)

function duration(a: Date, b: Date): string {
  const m = minutes(a, b)
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`
}

const fit = (text: string, width = 576) => pxTruncate(text, width - 4)

function direction(leg: Leg): string {
  const train = [leg.kind, leg.headsign && (/回り/.test(leg.headsign) ? leg.headsign : `${leg.headsign}行`)]
  return [leg.line, ...train].filter(Boolean).join(' ')
}

export const journeyItems = (journeys: Journey[]) => [
  '▲ 前の時間',
  ...journeys.map(j => `${hhmm(j.departure)}→${hhmm(j.arrival)}  ${duration(j.departure, j.arrival)}  乗換${j.transfers}`),
  '▼ 次の時間',
]

export const route = (from: string, to: string) => [fit(from, 576 - LIST_W), '↓', fit(to, 576 - LIST_W)].join('\n')

/** 駅を選ぶ画面の1行。同名・同音の駅を見分けられるよう都道府県と路線を添える。リストの項目は 64 文字まで。 */
export const stationItem = (s: Station) => [...fit(`${s.name}（${s.pref} ${s.line}）`)].slice(0, 64).join('')

// グラスの文字は左寄せしかできないので、空白を前に詰めて中央に寄せる。
const centered = (line: string) => ' '.repeat(Math.max(0, Math.round((576 - getTextWidth(line)) / 2 / getTextWidth(' ')))) + line

/** 検索中の画面の文字。秒数が進むことで、固まっていないことを伝える。 */
export const searching = (from: Station, to: Station, seconds: number) =>
  [`${from.name} → ${to.name}`, `経路を検索中  ${seconds}秒`].map(l => centered(fit(l))).join('\n')

const BLOCKS = '▁▂▃▄▅▆▇█'
export const LEVEL_BARS = 8

/** 声の大きさ（RMS、古い順）の棒。-50dB〜-10dB を8段にする。届いた数が足りないうちは低い段で埋めて、幅を変えない。 */
export const levelBar = (levels: number[]) =>
  [...Array(Math.max(0, LEVEL_BARS - levels.length)).fill(0), ...levels.slice(-LEVEL_BARS)]
    .map(rms => BLOCKS[Math.max(0, Math.min(7, Math.round(((20 * Math.log10(Math.max(rms, 1e-5)) + 50) / 40) * 7)))])
    .join('')

/** lines 行に収まらない文字は、頭を「…」にして終わりの方を見せる。話している途中の文字は終わりが新しいので。 */
export function lastLines(text: string, lines: number, width = 576): string {
  const fits = (s: string) => measureTextWrap(s, width - 4).lineCount <= lines
  if (fits(text)) return text
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fits(`…${text.slice(mid)}`)) hi = mid
    else lo = mid + 1
  }
  return `…${text.slice(lo)}`
}

// 駅が1つに決まっていなければ、後で選ばせることが分かるよう「？」を付ける。
const pickName = (c: Candidates) => `${c.stations[0].name}${c.sure && c.stations.length === 1 ? '' : '？'}`

/** 音声の途中経過や確定した文字から引けた駅。スマホにはこのまま、グラスには heardRoute で中央に寄せて出す。 */
export const routeLabel = (from: Candidates, to: Candidates) => `${pickName(from)} → ${pickName(to)}`

export const heardRoute = (from: Candidates, to: Candidates) => centered(fit(routeLabel(from, to)))

export function currentLegIndex(j: Journey, now: Date): number {
  const i = j.legs.findIndex(l => l.to.time > now)
  return i === -1 ? j.legs.length - 1 : i
}

export function strip(j: Journey, now: Date): string {
  const i = currentLegIndex(j, now)
  const leg = j.legs[i]
  const next = j.legs[i + 1]
  const untilDep = minutes(now, leg.from.time)
  const status = untilDep >= 0 ? `${hhmm(leg.from.time)}発(あと${untilDep}分)` : `乗車中 あと${Math.max(0, minutes(now, leg.to.time))}分`
  const tail = next ? `→ ${next.line || direction(next)} ${hhmm(next.from.time)}発` : '到着'
  return [fit(`▶ ${leg.from.name} ${direction(leg)} ${status}`), fit(`  ${leg.to.name} ${hhmm(leg.to.time)}着 ${tail}`)].join('\n')
}

export type Columns = { header: string; times: string; body: string }

// 矢印の列。本文の右端に置き、見えていない行が上下に残っているかを示す。
export const ARROW_W = 24

export const overviewMaxTop = (j: Journey) => Math.max(0, 1 + 2 * j.legs.length - ROWS)

/** 経路の全体。乗換が多いと ROWS 行に収まらないので、top 行目から見せる。 */
export function overview(j: Journey, top: number): Columns & { more: string } {
  const times = ['']
  const body = [`◎ ${j.from}`]
  j.legs.forEach((leg, i) => {
    times.push(hhmm(leg.from.time))
    body.push(`┃ ${direction(leg)} ${minutes(leg.from.time, leg.to.time)}分`)
    times.push(hhmm(leg.to.time))
    const next = j.legs[i + 1]
    body.push(next ? `● ${leg.to.name} 乗換${minutes(leg.to.time, next.from.time)}分` : `◎ ${leg.to.name}`)
  })
  const more = Array<string>(ROWS).fill('')
  if (top > 0) more[0] = '▲'
  if (top + ROWS < body.length) more[ROWS - 1] = '▼'
  return {
    header: fit(`${j.from} → ${j.to}  ${hhmm(j.departure)}–${hhmm(j.arrival)}  ${duration(j.departure, j.arrival)}  乗換${j.transfers}回`, HEADER_W),
    times: times.slice(top, top + ROWS).join('\n'),
    body: body.slice(top, top + ROWS).map(l => fit(l, BODY_W - ARROW_W)).join('\n'),
    more: more.join('\n'),
  }
}

export function stops(j: Journey, now: Date): Columns {
  const leg = j.legs[currentLegIndex(j, now)]
  const all: Stop[] = [leg.from, ...leg.intermediate, leg.to]
  const found = all.findIndex(s => s.time > now)
  const nextIdx = found === -1 ? all.length - 1 : found
  const start = Math.max(0, Math.min(nextIdx, all.length - ROWS))
  const shown = all.slice(start, start + ROWS)
  return {
    header: fit(`${direction(leg)}  ${leg.to.name}まで あと${found === -1 ? 0 : all.length - found}駅`, HEADER_W),
    times: shown.map(s => hhmm(s.time)).join('\n'),
    body: shown
      .map((s, k) => fit(`${start + k === nextIdx ? '▶' : '  '} ${s.name}${start + k === all.length - 1 && j.legs.at(-1) !== leg ? '  乗換' : ''}`, BODY_W))
      .join('\n'),
  }
}

// 席を立って荷物を持ち、扉まで行くのに要る時間。
const ALIGHT_NOTICE_MS = 3 * 60_000
export const NOTICE_MS = 10_000
export const NOTICE_W = 480
export const NOTICE_BORDER = 2
export const NOTICE_PAD = 10
const NOTICE_INSET = 2 * (NOTICE_BORDER + NOTICE_PAD)
export const NOTICE_H = 4 * 28 + NOTICE_INSET

export function alighting(j: Journey, now: Date): number | null {
  const i = currentLegIndex(j, now)
  const leg = j.legs[i]
  const left = leg.to.time.getTime() - now.getTime()
  const previous = leg.intermediate.at(-1) ?? leg.from
  return now >= previous.time && left > 0 && left <= ALIGHT_NOTICE_MS ? i : null
}

// 棒だけだと、駅に着くまでの時間に見える。
const CLOSING = '閉じるまで '

/** 降りる駅の知らせ。閉じるまでの行は薄く出すので、別の容器に入れられるよう分けて返す。棒は知らせが閉じるまでの残りの時間だけ伸びる。 */
export function notice(j: Journey, leg: number, until: number, now: Date): { body: string; closing: string } {
  const { to } = j.legs[leg]
  const next = j.legs[leg + 1]
  const left = minutes(now, to.time)
  const width = NOTICE_W - NOTICE_INSET
  const barW = width - getTextWidth(CLOSING)
  const bar = '─'.repeat(Math.floor((barW * Math.max(0, until - now.getTime())) / NOTICE_MS / getTextWidth('─')))
  return {
    body: [
      `次で${next ? '降ります' : '到着'}  ${to.name}`,
      `${hhmm(to.time)}着  ${left > 0 ? `あと${left}分` : 'まもなく'}`,
      next ? `乗換 ${next.line || direction(next)} ${hhmm(next.from.time)}発` : '',
    ]
      .map(l => fit(l, width))
      .join('\n'),
    closing: CLOSING + bar,
  }
}
