import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transcribe } from '../src/transcribe.ts'
import { fakeBridge } from './bridge.mjs'

/** recognize を呼ばれた順に覚え、テストが resolve・reject するまで返さない認識器。 */
const fakeRecognizer = () => {
  const calls = []
  return {
    calls,
    recognize(pcm) {
      return new Promise((resolve, reject) => calls.push({ samples: pcm.length, resolve, reject }))
    },
  }
}

const flush = () => new Promise(r => setTimeout(r, 0))

const start = async (options = {}) => {
  const bridge = fakeBridge()
  const recognizer = fakeRecognizer()
  const partials = []
  const events = []
  const t = await transcribe(bridge, recognizer, { onPartial: s => partials.push(s), onStop: () => events.push('stop'), ...options })
  return { bridge, recognizer, partials, events, t }
}

test('録っている途中で認識し直して onPartial に渡し、前の認識が終わるまで次を始めない', async () => {
  const { bridge, recognizer, partials } = await start()
  bridge.send(0.5, 2)
  assert.equal(recognizer.calls.length, 0, '0.3 秒たまるまでは認識しない')
  bridge.send(0.5, 1)
  assert.equal(recognizer.calls.length, 1)
  assert.equal(recognizer.calls[0].samples, 3 * 1600)
  bridge.send(0.5, 5)
  assert.equal(recognizer.calls.length, 1, '認識中に届いた音声では次を始めない')
  recognizer.calls[0].resolve('東京')
  await flush()
  assert.deepEqual(partials, ['東京'])
  assert.equal(recognizer.calls.length, 2, '終わったらすぐ、それまでの音声で次を始める')
  assert.equal(recognizer.calls[1].samples, 8 * 1600)
  recognizer.calls[1].resolve('東京')
  await flush()
  assert.deepEqual(partials, ['東京'], '同じ文字なら知らせない')
})

test('声とみなす大きさの音が来るまでは途中の認識をせず、来ないまま止まったら全部の音声を認識する', async () => {
  const { bridge, recognizer, partials, t } = await start()
  bridge.send(0.01, 7)
  assert.equal(recognizer.calls.length, 0)
  t.stop()
  await flush()
  assert.equal(recognizer.calls[0].samples, 7 * 1600)
  recognizer.calls[0].resolve('とうきょう')
  assert.equal(await t.final, 'とうきょう')
  assert.deepEqual(partials, [])
})

test('話の切れ目では、声の後ろの無音が 0.3 秒になるまで待ってから認識する', async () => {
  const { bridge, recognizer } = await start()
  bridge.send(0.5, 3)
  recognizer.calls[0].resolve('東京')
  await flush()
  bridge.send(0, 2)
  assert.equal(recognizer.calls.length, 1, '0.2 秒の無音ではまだ認識しない')
  bridge.send(0, 1)
  assert.equal(recognizer.calls.length, 2)
  assert.equal(recognizer.calls[1].samples, 6 * 1600)
})

test('無音で止まったら、声の 0.3 秒後までを認識した途中経過を認識し直さずに確定にする', async () => {
  const { bridge, recognizer, partials, t } = await start({ silenceMs: 1000 })
  bridge.send(0.5, 5)
  bridge.send(0, 5)
  recognizer.calls[0].resolve('東京から')
  await flush()
  assert.equal(recognizer.calls[1].samples, 8 * 1600, '最後の声の 0.3 秒後までで切って認識する')
  recognizer.calls[1].resolve('東京から箱根湯本まで')
  await flush()
  bridge.send(0, 5)
  assert.equal(await t.final, '東京から箱根湯本まで')
  assert.equal(recognizer.calls.length, 2, '声の後ろに無音が増えただけでは認識し直さない')
  assert.deepEqual(partials, ['東京から', '東京から箱根湯本まで'])
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
})

test('話し終えてすぐ stop したら、走っている認識を待ってから全部の音声を認識して確定する', async () => {
  const { bridge, recognizer, events, t } = await start()
  bridge.send(0.5, 5)
  bridge.send(0.5, 2)
  t.stop()
  await flush()
  assert.deepEqual(events, ['stop'], '確定を待つ間に録音が止まったことを知らせる')
  assert.equal(recognizer.calls.length, 1, '走っている認識が終わるまで確定の認識を始めない')
  recognizer.calls[0].resolve('東京から')
  await flush()
  assert.equal(recognizer.calls.length, 2)
  assert.equal(recognizer.calls[1].samples, 7 * 1600)
  recognizer.calls[1].resolve('東京から箱根湯本まで')
  assert.equal(await t.final, '東京から箱根湯本まで')
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
})

test('cancel は null を返し、後から終わった認識を onPartial に渡さない', async () => {
  const { bridge, recognizer, partials, events, t } = await start()
  bridge.send(0.5, 3)
  t.cancel()
  assert.equal(await t.final, null)
  recognizer.calls[0].resolve('東京')
  await flush()
  assert.deepEqual(partials, [])
  assert.deepEqual(events, [], 'cancel では onStop を呼ばない')
  assert.equal(recognizer.calls.length, 1)
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
})

test('認識が失敗したら録音を止め、final がその理由で reject する', async () => {
  const { bridge, recognizer, t } = await start()
  bridge.send(0.5, 3)
  recognizer.calls[0].reject(new Error('WASM が落ちた'))
  await assert.rejects(t.final, /WASM が落ちた/)
  assert.deepEqual(bridge.mic.at(-1), ['close'])
  assert.equal(bridge.handlers.size, 0)
})
