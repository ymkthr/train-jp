import type { Station } from './asr/stations'

const TRANSITOUS = 'https://api.transitous.org/api'
const HEARTRAILS = 'https://express.heartrails.com/api/json'

export type Stop = { name: string; time: Date; lat: number; lon: number }

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

type MotisPlace = {
  name: string
  stopId?: string
  lat: number
  lon: number
  departure?: string
  arrival?: string
  scheduledDeparture?: string
  scheduledArrival?: string
  pickupType?: 'NORMAL' | 'NOT_ALLOWED'
  dropoffType?: 'NORMAL' | 'NOT_ALLOWED'
  cancelled?: boolean
}
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

const stopOf = (p: MotisPlace, t?: string): Stop => ({ name: p.name, time: new Date(t ?? p.departure ?? p.arrival ?? ''), lat: p.lat, lon: p.lon })

async function toLeg(l: MotisLeg): Promise<Leg> {
  const intermediate = (l.intermediateStops ?? []).map(s => stopOf(s, s.arrival ?? s.departure))
  const line = l.routeLongName || (await inferLine([l.from.name, l.to.name, ...intermediate.map(s => s.name)]))
  // 路線名の無い区間（Transitous の全国 JR フィードの新幹線など）は、routeShortName に「のぞみ39号」のような列車名が入る。数字だけなら ID なので出さない。
  const short = l.routeShortName ?? ''
  const train = !l.routeLongName && !/^\d*$/.test(short) ? short : ''
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

// MOTIS は出発・到着・乗り換え回数が同じ経路を区別しないので、箱崎宮前 → 名古屋 で中洲川端で乗り換えられるのに大濠公園まで乗って引き返すような経路も返す。
// 引き返す分だけ待ち時間は元の乗り換えより長くなるので、乗り換えの時間は確かめない。降りられない駅、乗れない駅は避ける。
function transferBeforeDetour(legs: MotisLeg[]): MotisLeg[] {
  for (let i = 1; i < legs.length; i++) {
    const passed = legs[i - 1].intermediateStops ?? []
    const ahead = legs[i].intermediateStops ?? []
    for (const [at, off] of passed.entries()) {
      if (!off.stopId || off.dropoffType === 'NOT_ALLOWED' || off.cancelled) continue
      const on = ahead.findIndex(q => q.stopId === off.stopId && q.pickupType !== 'NOT_ALLOWED' && !q.cancelled)
      if (on < 0) continue
      legs[i - 1] = { ...legs[i - 1], to: off, endTime: off.arrival!, intermediateStops: passed.slice(0, at) }
      legs[i] = { ...legs[i], from: ahead[on], startTime: ahead[on].departure!, intermediateStops: ahead.slice(on + 1) }
      break
    }
  }
  return legs
}

export type JourneyPage = { journeys: Journey[]; earlier: string; later: string }

// 件数の上限を付けないと、後の時間帯のページで 50 件を超え、区間ごとの HeartRails の照会が積み上がる。
const PAGE = 10

type MotisStop = { id: string; name: string; modes?: string[] }

// 駅の座標を直接渡すと、終点の座標まで歩ける時間（既定 15 分）を超える駅では、座標の近くのバス停を経由する遠回り（福岡市内の駅 → 博多 で熊本往復の高速バス）が返る。座標を停留所 ID に置き換えて駅から駅へ引く。
async function placeOf(station: Station): Promise<string> {
  const coord = `${station.lat},${station.lon}`
  const stops = await getJson<MotisStop[]>(`${TRANSITOUS}/v1/reverse-geocode?place=${encodeURIComponent(coord)}&type=STOP`)
  const trains = stops.filter(s => s.modes?.some(m => m !== 'BUS' && m !== 'COACH'))
  const named = trains.find(s => bareName(s.name).normalize('NFKC') === station.name.normalize('NFKC'))
  return (named ?? trains[0])?.id ?? coord
}

// 名前で geocode すると、同名の駅や表記の違う駅（西線16条 → 西線６条、松山 → 台湾の松山）を拾うことがあるので、停留所は座標から引く。
export async function searchJourneys(from: Station, to: Station, cursor?: string): Promise<JourneyPage> {
  const [fromPlace, toPlace] = await Promise.all([placeOf(from), placeOf(to)])
  const plan = await getJson<{ itineraries: MotisItinerary[]; previousPageCursor: string; nextPageCursor: string }>(
    `${TRANSITOUS}/v5/plan?fromPlace=${encodeURIComponent(fromPlace)}&toPlace=${encodeURIComponent(toPlace)}` +
      `&time=${encodeURIComponent(new Date().toISOString())}&language=ja&maxItineraries=${PAGE}` +
      (cursor ? `&pageCursor=${encodeURIComponent(cursor)}` : ''),
  )
  const journeys = await Promise.all(
    plan.itineraries.map(async it => {
      const legs = await Promise.all(transferBeforeDetour(it.legs.filter(l => l.mode !== 'WALK')).map(toLeg))
      return {
        from: from.name,
        to: to.name,
        departure: legs[0]?.from.time ?? new Date(it.startTime),
        arrival: legs.at(-1)?.to.time ?? new Date(it.endTime),
        transfers: it.transfers,
        legs,
      }
    }),
  )
  return { journeys, earlier: plan.previousPageCursor, later: plan.nextPageCursor }
}
