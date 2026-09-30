const TRANSITOUS = 'https://api.transitous.org/api'
const HEARTRAILS = 'https://express.heartrails.com/api/json'

export type Stop = { name: string; time: Date }

export type Leg = {
  line: string
  kind: string
  headsign: string
  from: Stop
  to: Stop
  intermediate: Stop[]
}

export type Journey = {
  from: string
  to: string
  departure: Date
  arrival: Date
  transfers: number
  legs: Leg[]
}

type MotisPlace = { name: string; departure?: string; arrival?: string; scheduledDeparture?: string; scheduledArrival?: string }
type MotisLeg = {
  mode: string
  from: MotisPlace
  to: MotisPlace
  startTime: string
  endTime: string
  headsign?: string
  routeLongName?: string
  routeShortName?: string
  intermediateStops?: MotisPlace[]
}
type MotisItinerary = { startTime: string; endTime: string; transfers: number; legs: MotisLeg[] }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json() as Promise<T>
}

export async function findStation(name: string): Promise<{ id: string; name: string }> {
  const hits = await getJson<{ id: string; name: string; type: string }[]>(
    `${TRANSITOUS}/v1/geocode?text=${encodeURIComponent(name)}&type=STOP&language=ja`,
  )
  const hit = hits.find(h => h.type === 'STOP')
  if (!hit) throw new Error(`駅が見つかりません: ${name}`)
  return hit
}

const bareName = (name: string) => name.replace(/\(.*\)$/, '')

async function linesAt(station: string): Promise<Set<string>> {
  const r = await getJson<{ response: { station?: { line: string }[] } }>(
    `${HEARTRAILS}?method=getStations&name=${encodeURIComponent(bareName(station))}`,
  )
  return new Set((r.response.station ?? []).map(s => s.line))
}

// Transitous の全国 JR フィードは路線名が空か数字 ID なので、停車駅すべてに共通する路線を HeartRails から引く。
async function inferLine(stops: string[]): Promise<string> {
  let candidates: Set<string> | undefined
  for (const stop of stops) {
    const lines = await linesAt(stop)
    if (!lines.size) continue
    candidates = candidates ? new Set([...candidates].filter(l => lines.has(l))) : lines
    if (candidates.size <= 1) break
  }
  return candidates?.values().next().value ?? ''
}

function splitHeadsign(raw = ''): { kind: string; headsign: string } {
  const m = raw.match(/^【(.+?)】(.*)$/)
  return m ? { kind: m[1], headsign: m[2] } : { kind: '', headsign: raw }
}

const stopOf = (p: MotisPlace, t?: string): Stop => ({ name: p.name, time: new Date(t ?? p.departure ?? p.arrival ?? '') })

async function toLeg(l: MotisLeg): Promise<Leg> {
  const intermediate = (l.intermediateStops ?? []).map(s => stopOf(s, s.arrival ?? s.departure))
  const named = [l.routeLongName, l.routeShortName].find(n => n && !/^\d+$/.test(n))
  const line = l.routeLongName || (await inferLine([l.from.name, l.to.name, ...intermediate.map(s => s.name)])) || named || ''
  const train = !l.routeLongName && named ? named : ''
  const { kind, headsign } = splitHeadsign(l.headsign)
  return {
    line,
    kind: kind || train,
    headsign,
    from: stopOf(l.from, l.startTime),
    to: stopOf(l.to, l.endTime),
    intermediate,
  }
}

export async function searchJourneys(fromName: string, toName: string, at = new Date()): Promise<Journey[]> {
  const [from, to] = await Promise.all([findStation(fromName), findStation(toName)])
  const plan = await getJson<{ itineraries: MotisItinerary[] }>(
    `${TRANSITOUS}/v5/plan?fromPlace=${encodeURIComponent(from.id)}&toPlace=${encodeURIComponent(to.id)}` +
      `&time=${encodeURIComponent(at.toISOString())}&language=ja`,
  )
  return Promise.all(
    plan.itineraries.map(async it => {
      const legs = await Promise.all(it.legs.filter(l => l.mode !== 'WALK').map(toLeg))
      return {
        from: bareName(from.name),
        to: bareName(to.name),
        departure: legs[0]?.from.time ?? new Date(it.startTime),
        arrival: legs.at(-1)?.to.time ?? new Date(it.endTime),
        transfers: it.transfers,
        legs,
      }
    }),
  )
}
