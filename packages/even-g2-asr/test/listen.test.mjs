import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listen, s16leToFloat32 } from '../src/listen.ts'
import { fakeBridge } from './bridge.mjs'

const settled = async p => {
  const pending = Symbol()
  return (await Promise.race([p, new Promise(r => setTimeout(() => r(pending), 10))])) !== pending
}

test('stop で止まり、それまでの音声を返し、マイクを閉じて購読を外す', async () => {
  const bridge = fakeBridge()
  const others = []
  bridge.onEvenHubEvent(e => others.push(e))
  const u = await listen(bridge)
  bridge.send(0.5, 3)
  u.stop()
  bridge.send(0.5, 2)
  const pcm = await u.stopped
  assert.equal(pcm.length, 3 * 1600)
  assert.ok(Math.abs(Math.abs(pcm[0]) - 0.5) < 1e-3)
  assert.deepEqual(bridge.mic, [['open', 'glasses'], ['close']])
  assert.equal(bridge.handlers.size, 1, 'アプリ側の購読だけが残る')
  assert.equal(others.length, 5, 'アプリ側の購読にも同じ音声が届く')
})

test('話した後に無音が続けば自分で止まる', async () => {
  const bridge = fakeBridge()
  const levels = []
  const u = await listen(bridge, { silenceMs: 1000, onLevel: r => levels.push(r) })
  bridge.send(0.5, 3)
  bridge.send(0, 9)
  assert.equal(await settled(u.stopped), false, '0.9 秒の無音では止まらない')
  bridge.send(0, 1)
  const pcm = await u.stopped
  assert.equal(pcm.length, 13 * 1600)
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
  assert.equal(levels.length, 13)
  assert.ok(levels[0] > 0.4 && levels.at(-1) === 0)
})

test('話し始める前の無音では止まらない', async () => {
  const bridge = fakeBridge()
  const u = await listen(bridge, { silenceMs: 1000 })
  bridge.send(0, 30)
  assert.equal(await settled(u.stopped), false)
  u.stop()
  assert.equal((await u.stopped).length, 30 * 1600)
})

test('上限の秒数で止まる', async () => {
  const bridge = fakeBridge()
  const u = await listen(bridge, { maxSeconds: 1 })
  bridge.send(0.5, 12)
  assert.equal((await u.stopped).length, 10 * 1600)
  assert.equal(bridge.handlers.size, 0)
})

test('cancel は音声を返さず、マイクを閉じて購読を外す', async () => {
  const bridge = fakeBridge()
  const u = await listen(bridge)
  bridge.send(0.5, 3)
  u.cancel()
  assert.equal(await u.stopped, null)
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
})

test('マイクを開けなければ失敗し、購読を残さない', async () => {
  const bridge = fakeBridge({ opens: false })
  await assert.rejects(listen(bridge), /マイク/)
  assert.equal(bridge.handlers.size, 0)
})

test('s16le を -1〜1 にする', () => {
  const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x40])
  assert.deepEqual([...s16leToFloat32(bytes)], [-1, 32767 / 32768, 0, 0.5])
})
