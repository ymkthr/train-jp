import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRoute, resolveStation } from './stations.ts'

/** 1駅に確定したらその駅名、選んでもらう必要があれば null。 */
const settled = c => (c.sure && c.stations.length === 1 ? c.stations[0].name : null)
const route = async text => {
  const r = await resolveRoute(text)
  return r && [settled(r.from), settled(r.to)]
}
const names = c => c.stations.map(s => s.name)

test('駅名・別名で1駅に確定する', async () => {
  assert.deepEqual(await route('北十二条から西十一丁目まで'), ['北12条', '西11丁目'])
  assert.deepEqual(await route('ジェイアール難波からなぎつじ'), ['JR難波', '椥辻'])
  assert.deepEqual(await route('八幡大橋から仙台まで'), ['八幡大橋（東陵高校）', '仙台'])
  assert.deepEqual(await route('新宿三丁目から新宿まで'), ['新宿三丁目', '新宿'])
  // 近くの同じ読みの駅（札幌とさっぽろ）では選ばせない
  assert.deepEqual(await route('札幌から大手町'), ['札幌', null])
})

test('前後の余計な語、「駅」「まで」、区切りは無視する', async () => {
  assert.deepEqual(await route('えっと東京から箱根湯本までお願い'), ['東京', '箱根湯本'])
  assert.deepEqual(await route('東京駅から 箱根湯本駅まで。'), ['東京', '箱根湯本'])
  assert.deepEqual(await route('とうきょうから箱根湯本'), ['東京', '箱根湯本'])
})

test('表記が違っても読みが同じなら確定する', async () => {
  assert.deepEqual(await route('札幌から西千十六条まで'), ['札幌', '西線16条'])
})

test('同名の駅は場所ごとに候補になり、選ばせる', async () => {
  const c = await resolveStation('高松')
  assert.equal(settled(c), null)
  assert.ok(c.stations.length >= 2)
  assert.ok(c.stations.every(s => s.name === '高松'))
  assert.equal(new Set(c.stations.map(s => s.pref)).size, c.stations.length)
  assert.ok(c.stations.some(s => s.pref === '香川県') && c.stations.some(s => s.pref === '東京都'))
})

test('同じ読みの駅も候補に入れる', async () => {
  const c = await resolveStation('等々力')
  assert.equal(settled(c), null)
  assert.ok(names(c).includes('等々力') && names(c).includes('驫木'))
})

test('読みが近いだけの駅は、1件でも確定せずに候補にする', async () => {
  for (const [said, want] of [['入ヶ池公園', '杁ヶ池公園'], ['二ツ入り', '二ツ杁'], ['高玉', '高擶'], ['JRの江', 'JR野江']]) {
    const c = await resolveStation(said)
    assert.equal(c.sure, false, said)
    assert.ok(names(c).includes(want), `${said} → ${names(c)}`)
  }
  const far = await resolveStation('東福津')
  assert.equal(settled(far), null)
})

test('引けないものは null か空', async () => {
  assert.equal(await resolveRoute('東京から'), null)
  assert.equal(await resolveRoute('東京と箱根湯本'), null)
  assert.deepEqual((await resolveStation('あいうえおかきくけこ')).stations, [])
})
