import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { listen, type ListenOptions, type Utterance } from './listen.ts'
import type { Recognizer } from './recognizer.ts'

export type TranscribeOptions = ListenOptions & {
  /** 録っている途中で、それまでの音声を認識した文字が変わるたびに呼ぶ。 */
  onPartial?: (text: string) => void
  /** 録音が止まって（stop・無音・上限。cancel では呼ばない）、マイクを閉じたときに呼ぶ。この後 final が解決する。 */
  onStop?: () => void
}

/** final は確定した文字。cancel したときは null。 */
export type Transcription = { final: Promise<string | null>; stop(): void; cancel(): void }

const RATE = 16000
// 話している間の途中の認識は、前の認識に渡した音声からこれだけ伸びてから始める。速い端末で 0.1 秒ごとに認識し直さないため。
const STEP = (RATE * 3) / 10
// 認識に渡す音声は、最後の声からこれだけ後ろで切る。gTTS の 10 本では声の終わりちょうどで切っても全部の音声と同じ文字になったので、
// 余裕を持たせた長さ。切っておけば、無音が続く間は認識し直さずに済み、止まったときは最後の途中経過をそのまま確定にできる。
const TAIL = (RATE * 3) / 10

/**
 * listen で1発話を録りながら、それまでの音声を認識し直して onPartial に渡す。認識は前の認識が終わってから次を始めるので重ならない。
 * 途中の認識の音声は listen の maxSeconds までしか伸びないので、1回の認識もその長さまでに収まる。
 * 止まったら（stop・無音・上限）最後の声の 0.3 秒後までを認識して final を解決する。最後の途中経過が同じところまで認識していれば、それを使う。
 * 声とみなせる音（speechRms 以上）がまだ来ていなければ途中の認識はしない。話し出す前の雑音を「えっ」などと書き出すので
 * （シミュレータで出た）。止まったときに声が一度も来ていなければ、全部の音声を認識する。
 * 認識に失敗したら録音を止め、final がその理由で reject する。
 */
export async function transcribe(
  bridge: Pick<EvenAppBridge, 'onEvenHubEvent' | 'audioControl'>,
  recognizer: Recognizer,
  options: TranscribeOptions = {},
): Promise<Transcription> {
  const { onPartial, onStop, onLevel, ...rest } = options
  let utterance: Utterance | undefined
  let open = true
  let running: Promise<void> | null = null
  let failure: Error | null = null
  /** 最後に終わった認識の文字と、その認識に渡した音声の長さ。 */
  let latest = { text: '', covers: 0 }
  const input = ({ pcm, speechEnd }: { pcm: Float32Array; speechEnd: number }) =>
    speechEnd < 0 || pcm.length <= speechEnd + TAIL ? pcm : pcm.slice(0, speechEnd + TAIL)

  const kick = () => {
    if (!utterance || running || !open || failure) return
    const r = utterance.recorded()
    if (r.speechEnd < 0) return
    const pcm = input(r)
    const cut = pcm.length === r.speechEnd + TAIL
    // 話の切れ目では、切れ目が TAIL に届くまで待つ。届いたところで認識しておけば、そのまま止まっても認識し直さずに済む。
    const paused = r.pcm.length > r.speechEnd && !cut
    if (paused || pcm.length === latest.covers || (!cut && pcm.length - latest.covers < STEP)) return
    running = recognizer.recognize(pcm).then(
      text => {
        const changed = text !== latest.text
        latest = { text, covers: pcm.length }
        if (open && changed) onPartial?.(text)
      },
      (err: Error) => {
        failure = err
        utterance?.stop()
      },
    )
    running.then(() => {
      running = null
      kick()
    })
  }

  utterance = await listen(bridge, {
    ...rest,
    onLevel: rms => {
      onLevel?.(rms)
      kick()
    },
  })
  const u = utterance
  kick()

  const final = u.stopped.then(async stopped => {
    open = false
    if (!stopped) return null
    onStop?.()
    await running
    if (failure) throw failure
    const pcm = input(u.recorded())
    return pcm.length === latest.covers ? latest.text : recognizer.recognize(pcm)
  })
  return { final, stop: u.stop, cancel: u.cancel }
}
