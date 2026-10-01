import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type { Station } from './asr/stations'
import type { Journey, Leg, Stop } from './journey'

export const TIME_W = 64
export const BODY_W = 576 - TIME_W
export const ROWS = 9

const hhmm = (d: Date) =>
  d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })

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

export function listItem(j: Journey): string {
  return `${hhmm(j.departure)}→${hhmm(j.arrival)}  ${duration(j.departure, j.arrival)}  乗換${j.transfers}`
}

/** 駅を選ぶ画面の1行。同名・同音の駅を見分けられるよう都道府県と路線を添える。リストの項目は 64 文字まで。 */
export const stationItem = (s: Station) => [...fit(`${s.name}（${s.pref} ${s.line}）`)].slice(0, 64).join('')

// グラスの文字は左寄せしかできないので、空白を前に詰めて中央に寄せる。
const centered = (line: string) => ' '.repeat(Math.max(0, Math.round((576 - getTextWidth(line)) / 2 / getTextWidth(' ')))) + line

/** 検索中の画面の文字。秒数が進むことで、固まっていないことを伝える。 */
export const searching = (from: Station, to: Station, seconds: number) =>
  [`${from.name} → ${to.name}`, `経路を検索中  ${seconds}秒`].map(l => centered(fit(l))).join('\n')

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

export function overview(j: Journey): Columns {
  const times = ['']
  const body = [`◎ ${j.from}`]
  j.legs.forEach((leg, i) => {
    times.push(hhmm(leg.from.time))
    body.push(`┃ ${direction(leg)} ${minutes(leg.from.time, leg.to.time)}分`)
    times.push(hhmm(leg.to.time))
    const next = j.legs[i + 1]
    body.push(next ? `● ${leg.to.name} 乗換${minutes(leg.to.time, next.from.time)}分` : `◎ ${leg.to.name}`)
  })
  return {
    header: fit(`${j.from} → ${j.to}  ${hhmm(j.departure)}–${hhmm(j.arrival)}  ${duration(j.departure, j.arrival)}  乗換${j.transfers}回`),
    times: times.slice(0, ROWS).join('\n'),
    body: body.slice(0, ROWS).map(l => fit(l, BODY_W)).join('\n'),
  }
}

export function stops(j: Journey, now: Date): Columns {
  const leg = j.legs[currentLegIndex(j, now)]
  const all: Stop[] = [leg.from, ...leg.intermediate, leg.to]
  const nextIdx = Math.max(0, all.findIndex(s => s.time > now))
  const start = Math.max(0, Math.min(nextIdx, all.length - ROWS))
  const shown = all.slice(start, start + ROWS)
  return {
    header: fit(`${direction(leg)}  ${leg.to.name}まで あと${all.length - nextIdx}駅`),
    times: shown.map(s => hhmm(s.time)).join('\n'),
    body: shown
      .map((s, k) => fit(`${start + k === nextIdx ? '▶' : '  '} ${s.name}${start + k === all.length - 1 && j.legs.at(-1) !== leg ? '  乗換' : ''}`, BODY_W))
      .join('\n'),
  }
}
