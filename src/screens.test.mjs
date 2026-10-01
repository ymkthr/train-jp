import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overview, overviewMaxTop } from './screens.ts'

const at = hm => new Date(`2026-10-01T${hm}:00+09:00`)
const stop = (name, hm) => ({ name, time: at(hm), lat: 35, lon: 139.7 })
const names = ['A', 'B', 'C', 'D', 'E', 'F']
const legs = names.slice(1).map((to, i) => ({
  line: `${i}線`, kind: '', headsign: to, intermediate: [],
  from: stop(names[i], `10:${String(i * 10).padStart(2, '0')}`),
  to: stop(to, `10:${String(i * 10 + 5).padStart(2, '0')}`),
}))
const journey = { from: 'A', to: 'F', departure: legs[0].from.time, arrival: legs[4].to.time, transfers: 4, legs }
const lines = s => s.split('\n')

test('乗換4回の経路は、下へ送ると到着駅まで見られる', () => {
  const first = overview(journey, 0)
  assert.ok(!first.body.includes('◎ F'))
  assert.equal(lines(first.more).at(-1), '▼')
  assert.notEqual(lines(first.more)[0], '▲')

  const last = overview(journey, overviewMaxTop(journey))
  assert.match(lines(last.body).at(-1), /◎ F/)
  assert.equal(lines(last.body).length, lines(last.times).length)
  assert.equal(lines(last.more)[0], '▲')
  assert.notEqual(lines(last.more).at(-1), '▼')
})

test('画面に収まる経路には矢印を出さない', () => {
  const short = { ...journey, to: 'C', arrival: legs[1].to.time, transfers: 1, legs: legs.slice(0, 2) }
  assert.equal(overviewMaxTop(short), 0)
  assert.doesNotMatch(overview(short, 0).more, /[▲▼]/)
})
