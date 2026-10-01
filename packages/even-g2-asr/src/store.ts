import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

/** 文字列だけを入れられる保存先。無いキーの get は空文字を返す。set は書けなければ false を返す。 */
export type KeyValueStore = {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<boolean>
}

/**
 * Even App 側の保存領域。WebView の origin はポートが起動ごとに変わるので、localStorage・IndexedDB・OPFS は次の起動で空になる。
 * こちらは再起動後も残る。
 */
export const evenStore = (bridge: Pick<EvenAppBridge, 'getLocalStorage' | 'setLocalStorage'>): KeyValueStore => ({
  get: async key => (await bridge.getLocalStorage(key)) ?? '',
  set: (key, value) => bridge.setLocalStorage(key, value),
})
