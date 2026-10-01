import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ON_TIME, expected, observe } from './progress.ts'
import { stops } from './screens.ts'

const at = hm => new Date(`2026-10-01T${hm}:00+09:00`)
const stop = (name, hm, lat) => ({ name, time: at(hm), lat, lon: 139.7 })
const journey = {
  from: 'A',
  to: 'E',
  departure: at('10:00'),
  arrival: at('10:20'),
  transfers: 1,
  legs: [
    { line: '甲線', kind: '', headsign: 'C', from: stop('A', '10:00', 35.0), intermediate: [stop('B', '10:02', 35.01)], to: stop('C', '10:04', 35.02) },
    { line: '乙線', kind: '', headsign: 'E', from: stop('C', '10:10', 35.02), intermediate: [stop('D', '10:15', 35.03)], to: stop('E', '10:20', 35.04) },
  ],
}
const fix = (lat, accuracy = 20) => ({ latitude: lat, longitude: 139.7, accuracy })
const marked = (lag, now) =>
  stops(expected(journey, lag), now)
    .body.split('\n')
    .find(l => l.startsWith('▶'))
    .slice(2)
    .replace(/\s+乗換$/, '')

test('GPS が無ければ時刻表どおりに進む', () => {
  assert.equal(marked(ON_TIME, at('10:01')), 'B')
  assert.equal(marked(ON_TIME, at('10:03')), 'C')
})

test('遅れて駅に着いたら、その遅れのぶん次の駅への移り変わりも遅らせる', () => {
  const lag = observe(journey, ON_TIME, fix(35.01), at('10:04'))
  assert.match(stops(expected(journey, lag), at('10:05')).header, /甲線/)
  assert.match(stops(expected(journey, ON_TIME), at('10:05')).header, /乙線/)
})

test('早く駅に着いたら、時刻表より先に次の駅へ進む', () => {
  const lag = observe(journey, ON_TIME, fix(35.01), at('10:01'))
  assert.equal(marked(lag, at('10:01')), 'C')
})

test('同じ駅に居続けても遅れは膨らまない', () => {
  const first = observe(journey, ON_TIME, fix(35.01), at('10:03'))
  assert.equal(observe(journey, first, fix(35.01), at('10:09')), first)
})

test('乗る駅で電車を待っていても遅れとみなさない', () => {
  assert.equal(observe(journey, ON_TIME, fix(35.0), at('10:05')), ON_TIME)
})

test('乗り換えた先の電車には前の電車の遅れを持ち込まない', () => {
  const lag = observe(journey, ON_TIME, fix(35.02), at('10:07'))
  assert.equal(marked(lag, at('10:11')), 'D')
})

test('乗り換えた先の電車に乗った後は、前の電車の駅に近づいても戻らない', () => {
  const onD = observe(journey, ON_TIME, fix(35.03), at('10:16'))
  assert.equal(observe(journey, onD, fix(35.02), at('10:17')), onD)
})

test('前の電車が、乗り換えた先の電車の停車駅のそばを通っても、そこに着いたとみなさない', () => {
  const back = {
    ...journey,
    legs: [
      { line: '快速', kind: '', headsign: '中野', from: stop('新宿', '10:00', 35.0), intermediate: [], to: stop('中野', '10:04', 35.02) },
      { line: '各停', kind: '', headsign: '東中野', from: stop('中野', '10:08', 35.02), intermediate: [], to: stop('東中野', '10:11', 35.01) },
    ],
  }
  assert.equal(observe(back, ON_TIME, fix(35.01), at('10:02')), ON_TIME)
})

test('精度の悪い位置や古い位置は使わない', () => {
  assert.equal(observe(journey, ON_TIME, fix(35.01, 800), at('10:04')), ON_TIME)
  const stale = { ...fix(35.01), timestamp: at('10:02').getTime() }
  assert.equal(observe(journey, ON_TIME, stale, at('10:04')), ON_TIME)
})

test('終点に着いた後も ▶ は終点に残り、残りの駅数は 0 になる', () => {
  assert.equal(marked(ON_TIME, at('10:30')), 'E')
  assert.match(stops(journey, at('10:30')).header, /あと0駅/)
})
