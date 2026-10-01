import type { AudioInputSource, EvenAppBridge } from '@evenrealities/even_hub_sdk'

export type ListenOptions = {
  /** 既定はグラスのマイク。スマホのマイクにするなら app.json に phone-microphone の権限が要る。 */
  source?: AudioInputSource
  /** 録音の上限の秒数。届いた音声の長さで数える。 */
  maxSeconds?: number
  /** 話し始めた後、この長さの無音が続いたら止める。届いた音声の長さで数える。 */
  silenceMs?: number
  /** これ以上の RMS（-1〜1 の音声）を声とみなす。 */
  speechRms?: number
  /** 音声が届くたびに、その区間の RMS を渡す。 */
  onLevel?: (rms: number) => void
}

/**
 * stopped は録った音声（16kHz mono、-1〜1）。cancel したときは null。
 * recorded は録っている途中でも呼べて、それまでの音声と、最後に声だったところの終わり（サンプル数。まだ声が無ければ -1）を返す。
 */
export type Utterance = {
  stopped: Promise<Float32Array | null>
  stop(): void
  cancel(): void
  recorded(): { pcm: Float32Array; speechEnd: number }
}

const RATE = 16000
// SDK の値を import すると、読み込んだだけでブリッジの初期化が走り window と document が要る（Node のテストで読めない）。
// AudioInputSource は文字列の enum なので値を直に書く。
const GLASSES = 'glasses' as AudioInputSource

/**
 * マイクを開いて1発話を録る。stop・話した後の無音・上限のどれかで止まり、マイクを閉じて購読を外してから stopped が解決する。
 * bridge.onEvenHubEvent は window のイベントに購読を足す作りなので、アプリ側の購読と並んで動く。
 * Even App ではグラスの画面を createStartUpPageContainer で作った後でないとマイクを開けない。
 */
export async function listen(bridge: Pick<EvenAppBridge, 'onEvenHubEvent' | 'audioControl'>, options: ListenOptions = {}): Promise<Utterance> {
  const { source = GLASSES, maxSeconds = 10, silenceMs = 1500, speechRms = 0.02, onLevel } = options
  const frames: Float32Array[] = []
  let samples = 0
  let lastSpeech = -1
  let done = false
  let finish = (_: Float32Array | null) => {}
  const stopped = new Promise<Float32Array | null>(resolve => (finish = resolve))

  const end = (keep: boolean) => {
    if (done) return
    done = true
    off()
    bridge
      .audioControl(false)
      .catch(() => false)
      .then(() => finish(keep ? concat(frames, samples) : null))
  }

  // マイクを開く前に購読しておく。開いた直後に届く音声を落とさないため。
  const off = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (!pcm || done) return
    const frame = s16leToFloat32(pcm)
    frames.push(frame)
    samples += frame.length
    let power = 0
    for (const x of frame) power += x * x
    const rms = frame.length ? Math.sqrt(power / frame.length) : 0
    if (rms >= speechRms) lastSpeech = samples
    onLevel?.(rms)
    if (samples >= maxSeconds * RATE || (lastSpeech >= 0 && samples - lastSpeech >= (silenceMs / 1000) * RATE)) end(true)
  })

  try {
    if (!(await bridge.audioControl(true, source))) throw new Error('マイクを開けませんでした')
  } catch (err) {
    done = true
    off()
    throw err
  }
  return { stopped, stop: () => end(true), cancel: () => end(false), recorded: () => ({ pcm: concat(frames, samples), speechEnd: lastSpeech }) }
}

function concat(frames: Float32Array[], samples: number): Float32Array {
  const out = new Float32Array(samples)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

/** G2 のマイクから届く s16le（リトルエンディアン 16bit）のバイト列を -1〜1 にする。 */
export function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
