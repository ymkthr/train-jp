import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchJourneys } from './journey.ts'

const place = (stopId, name, arrival, departure) => ({ stopId, name, lat: 33.6, lon: 130.4, arrival, departure })
const t = hm => `2026-10-01T${hm}:00Z`
const 箱崎宮前 = place('jp-japan-rail_8375', '箱崎宮前', null, t('20:37'))
const 呉服町 = place('jp-japan-rail_8372', '呉服町(福岡県)', t('20:38'), t('20:38'))
const 中洲川端 = (hm, door = {}) => ({ ...place('jp-japan-rail_7764', '中洲川端', t(hm), t(hm)), ...door })
const 天神 = (hm) => place('jp-japan-rail_7765', '天神', t(hm), t(hm))
const 赤坂 = (hm) => place('jp-japan-rail_7766', '赤坂(福岡県)', t(hm), t(hm))
const 大濠公園 = (arr, dep) => place('jp-japan-rail_7767', '大濠公園', arr, dep)
const 祇園 = place('jp-japan-rail_7763', '祇園(福岡県)', t('20:57'), t('20:57'))
const 博多 = (arr, dep) => place('jp-japan-rail_4102', '博多', arr, dep)

// 箱崎宮前 → 名古屋 で実際に返った経路。箱崎線の電車は中洲川端に止まり、空港線の電車も中洲川端を通るのに、大濠公園まで乗って引き返す。
const detour = (door = {}) => ({
  startTime: t('20:37'),
  endTime: t('21:17'),
  transfers: 1,
  legs: [
    { mode: 'REGIONAL_RAIL', from: 箱崎宮前, to: 大濠公園(t('20:46'), null), startTime: t('20:37'), endTime: t('20:46'), routeLongName: '箱崎線', intermediateStops: [呉服町, 中洲川端('20:40', door), 天神('20:42'), 赤坂('20:44')] },
    { mode: 'WALK', from: 大濠公園(t('20:46'), null), to: 大濠公園(null, t('20:48')), startTime: t('20:46'), endTime: t('20:48') },
    { mode: 'REGIONAL_RAIL', from: 大濠公園(null, t('20:49')), to: 博多(t('20:58'), null), startTime: t('20:49'), endTime: t('20:58'), routeLongName: '空港線', intermediateStops: [赤坂('20:51'), 天神('20:53'), 中洲川端('20:55'), 祇園] },
  ],
})

async function search(ctx, itinerary) {
  ctx.mock.method(globalThis, 'fetch', async url => {
    const body = String(url).includes('/v5/plan') ? { itineraries: [itinerary], previousPageCursor: '', nextPageCursor: '' } : []
    return new Response(JSON.stringify(body))
  })
  const station = { name: '', pref: '', line: '', lat: 33.6, lon: 130.4, kana: [], aliases: [] }
  return (await searchJourneys(station, station)).journeys[0]
}

test('引き返す乗り換えは、二つの電車が両方止まる最初の駅での乗り換えに直す', async ctx => {
  const journey = await search(ctx, detour())
  const [hakozaki, kuko] = journey.legs
  assert.equal(hakozaki.to.name, '中洲川端')
  assert.deepEqual(hakozaki.to.time, new Date(t('20:40')))
  assert.deepEqual(hakozaki.intermediate.map(s => s.name), ['呉服町(福岡県)'])
  assert.equal(kuko.from.name, '中洲川端')
  assert.deepEqual(kuko.from.time, new Date(t('20:55')))
  assert.deepEqual(kuko.intermediate.map(s => s.name), ['祇園(福岡県)'])
  assert.deepEqual(journey.departure, new Date(t('20:37')))
  assert.deepEqual(journey.arrival, new Date(t('20:58')))
})

test('降りられない駅では乗り換えさせず、次に両方が止まる駅で乗り換える', async ctx => {
  for (const door of [{ dropoffType: 'NOT_ALLOWED' }, { cancelled: true }]) {
    const [hakozaki, kuko] = (await search(ctx, detour(door))).legs
    assert.equal(hakozaki.to.name, '天神', JSON.stringify(door))
    assert.equal(kuko.from.name, '天神', JSON.stringify(door))
  }
})
