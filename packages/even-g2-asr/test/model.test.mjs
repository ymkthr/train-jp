import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { isModelCached, loadModel } from '../src/model.ts'
import { Sha256 } from '../src/sha256.ts'

const memoryStore = () => {
  const map = new Map()
  return {
    map,
    get: async key => map.get(key) ?? '',
    set: async (key, value) => (map.set(key, value), true),
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// 2.5 チャンク・ちょうど 1 チャンク・1 チャンク未満・1 バイト
const DATA = {
  encoder: randomBytes(786432 * 2 + 393216),
  decoder: randomBytes(786432),
  joiner: randomBytes(1000),
  tokens: Buffer.from('あ'),
}

const specOf = (id, data = DATA) => ({
  id,
  ...Object.fromEntries(
    Object.entries(data).map(([name, bytes]) => [name, { url: `https://models.test/${id}/${name}`, bytes: bytes.length, sha256: sha256(bytes) }]),
  ),
})

/** url の末尾のファイル名で DATA を返す。failAfter バイトを流したところでストリームを壊せる。 */
const fakeFetch = ({ data = DATA, failAfter = {} } = {}) => {
  const urls = []
  const fetch = async url => {
    urls.push(url)
    const name = url.split('/').pop()
    const bytes = data[name]
    let at = 0
    return new Response(
      new ReadableStream({
        pull(c) {
          if (failAfter[name] !== undefined && at >= failAfter[name]) return c.error(new Error('接続が切れた'))
          if (at >= bytes.length) return c.close()
          // チャンクの境目と揃わない大きさで流す。
          const n = Math.min(100003, bytes.length - at)
          c.enqueue(new Uint8Array(bytes.subarray(at, at + n)))
          at += n
        },
      }),
    )
  }
  return { urls, fetch }
}

const withFetch = async (f, run) => {
  const original = globalThis.fetch
  globalThis.fetch = f.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const assertSame = files => {
  for (const name of Object.keys(DATA)) assert.deepEqual(Buffer.from(files[name]), DATA[name], name)
}

test('初回はダウンロードし、二回目は fetch せずに同じバイト列を復元する', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  const first = fakeFetch()
  const phases = []
  assertSame(await withFetch(first, () => loadModel(spec, store, p => phases.push(p))))
  assert.equal(first.urls.length, 4)
  assert.equal(phases.at(-1).phase, 'download')
  assert.equal(phases.at(-1).loaded, phases.at(-1).total)
  assert.equal(await isModelCached(spec, store), true)

  const second = fakeFetch()
  const restored = []
  assertSame(await withFetch(second, () => loadModel(spec, store, p => restored.push(p))))
  assert.deepEqual(second.urls, [])
  assert.ok(restored.every(p => p.phase === 'restore'))
  assert.equal(restored.at(-1).loaded, restored.at(-1).total)
})

test('ダウンロードの途中で切れたら目録は揃ったことにならず、次の呼び出しで揃う', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  await assert.rejects(withFetch(fakeFetch({ failAfter: { encoder: 900000 } }), () => loadModel(spec, store)))
  assert.equal(await isModelCached(spec, store), false)

  assertSame(await withFetch(fakeFetch(), () => loadModel(spec, store)))
  assert.equal(await isModelCached(spec, store), true)
})

test('チャンクが欠けていたら取り直し、その後は復元だけで済む', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  await withFetch(fakeFetch(), () => loadModel(spec, store))
  store.map.set('even-g2-asr/m1/encoder/1', '')

  const again = fakeFetch()
  assertSame(await withFetch(again, () => loadModel(spec, store)))
  assert.equal(again.urls.length, 4)

  const third = fakeFetch()
  assertSame(await withFetch(third, () => loadModel(spec, store)))
  assert.deepEqual(third.urls, [])
})

test('チャンクの長さが違えば取り直す', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  await withFetch(fakeFetch(), () => loadModel(spec, store))
  store.map.set('even-g2-asr/m1/joiner/0', store.map.get('even-g2-asr/m1/joiner/0').slice(4))

  const again = fakeFetch()
  assertSame(await withFetch(again, () => loadModel(spec, store)))
  assert.equal(again.urls.length, 4)
})

test('sha256 が合わなければ失敗し、揃ったことにしない', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  spec.joiner = { ...spec.joiner, sha256: '0'.repeat(64) }
  await assert.rejects(withFetch(fakeFetch(), () => loadModel(spec, store)), /sha256/)
  assert.equal(await isModelCached(spec, store), false)
  assert.equal(JSON.parse(store.map.get('even-g2-asr/manifest')).complete, false)
})

test('大きさが spec と違えば失敗する', async () => {
  const store = memoryStore()
  const spec = specOf('m1')
  spec.decoder = { ...spec.decoder, bytes: spec.decoder.bytes - 1 }
  await assert.rejects(withFetch(fakeFetch(), () => loadModel(spec, store)), /大きさ/)
  assert.equal(await isModelCached(spec, store), false)
})

test('spec の id が変われば取り直し、古い id のチャンクを空にする', async () => {
  const store = memoryStore()
  await withFetch(fakeFetch(), () => loadModel(specOf('old'), store))
  const oldKeys = [...store.map.keys()].filter(k => k.startsWith('even-g2-asr/old/'))
  assert.equal(oldKeys.length, 3 + 1 + 1 + 1)

  const next = specOf('new')
  const f = fakeFetch()
  assertSame(await withFetch(f, () => loadModel(next, store)))
  assert.equal(f.urls.length, 4)
  assert.ok(oldKeys.every(k => store.map.get(k) === ''))
  assert.equal(await isModelCached(next, store), true)
  assert.equal(await isModelCached(specOf('old'), store), false)
})

test('古いモデルを空にしている途中で落ちても、次の呼び出しで新しいモデルに揃う', async () => {
  const store = memoryStore()
  await withFetch(fakeFetch(), () => loadModel(specOf('old'), store))
  let writes = 0
  const flaky = { get: store.get, set: async (k, v) => (++writes > 2 ? false : store.set(k, v)) }
  await assert.rejects(withFetch(fakeFetch(), () => loadModel(specOf('new'), flaky)))

  assertSame(await withFetch(fakeFetch(), () => loadModel(specOf('new'), store)))
  assert.ok([...store.map].filter(([k]) => k.startsWith('even-g2-asr/old/')).every(([, v]) => v === ''))
})

test('Sha256 は分けて足しても node:crypto と同じ値になる', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
    const bytes = randomBytes(n)
    const h = new Sha256()
    for (let at = 0; at < n; at += 37) h.update(bytes.subarray(at, at + 37))
    assert.equal(h.hex(), sha256(bytes), `${n} バイト`)
  }
})
