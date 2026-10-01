import type { AppLocation } from '@evenrealities/even_hub_sdk'
import type { Journey, Leg, Stop } from './journey'

export type Lag = { leg: number; stop: number; ms: number }

export const ON_TIME: Lag = { leg: -1, stop: -1, ms: 0 }

// 駅のホームは 200m ほどあり、停車駅の座標はホームのどこかを指す。
const NEAR_M = 250
// 地下では古い位置や基地局からの粗い位置が届くので、精度と鮮度で捨てる。
const WORST_ACCURACY_M = 150
const STALE_MS = 30_000

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * 6_371_000
}

const beyond = (a: { leg: number; stop: number }, b: { leg: number; stop: number }) => a.leg > b.leg || (a.leg === b.leg && a.stop > b.stop)

const boarded = (l: Leg, now: Date) => now >= l.from.time

export function observe(j: Journey, lag: Lag, fix: AppLocation, now: Date): Lag {
  if (fix.accuracy === undefined || fix.accuracy > WORST_ACCURACY_M) return lag
  if (fix.timestamp !== undefined && now.getTime() - fix.timestamp > STALE_MS) return lag
  const here = { lat: fix.latitude, lon: fix.longitude }
  for (const [leg, l] of j.legs.entries()) {
    if (!boarded(l, now)) break
    const arrivals = [...l.intermediate, l.to]
    for (const [stop, s] of arrivals.entries()) {
      if (!beyond({ leg, stop }, lag) || metres(here, s) > NEAR_M) continue
      return { leg, stop, ms: now.getTime() - s.time.getTime() }
    }
  }
  return lag
}

const shift = (s: Stop, ms: number): Stop => ({ ...s, time: new Date(s.time.getTime() + ms) })

export function expected(j: Journey, lag: Lag): Journey {
  if (!lag.ms) return j
  return {
    ...j,
    legs: j.legs.map((l, i) =>
      i === lag.leg ? { ...l, from: shift(l.from, lag.ms), to: shift(l.to, lag.ms), intermediate: l.intermediate.map(s => shift(s, lag.ms)) } : l,
    ),
  }
}
