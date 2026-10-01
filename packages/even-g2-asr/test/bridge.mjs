// listen と transcribe のテストが使う偽の bridge。
export const fakeBridge = ({ opens = true } = {}) => {
  const handlers = new Set()
  const mic = []
  return {
    handlers,
    mic,
    onEvenHubEvent(cb) {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
    async audioControl(isOpen, source) {
      mic.push(isOpen ? ['open', source] : ['close'])
      return isOpen ? opens : true
    },
    /** 100ms（1600 サンプル）の s16le を、振幅 amp の矩形波で流す。 */
    send(amp, frames = 1) {
      for (let f = 0; f < frames; f++) {
        const view = new DataView(new ArrayBuffer(3200))
        for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round((i % 2 ? amp : -amp) * 32767), true)
        for (const h of [...handlers]) h({ audioEvent: { audioPcm: new Uint8Array(view.buffer) } })
      }
    },
  }
}
