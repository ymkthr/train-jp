# even-g2-asr

Even Realities G2 のアプリで、日本語の音声をスマホの中で文字にする部品。音声は外へ送らない。

- 認識は [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.13.8 を WebAssembly（スレッドなし・SIMD あり）にしたもの。モデルは ReazonSpeech k2-v2。Web Worker の中で動くので、認識の間もタップや画面の更新は止まらない。
- モデル（約 170MB）は初回だけネットから取り、Even App の保存領域（`bridge.setLocalStorage`）に入れる。2回目からはそこから戻す。
- 録音は G2 のマイク（`bridge.audioControl`）。話している途中から、それまでの音声を認識し直した文字（途中経過）を返す。

## 使い方

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { REAZONSPEECH_K2_V2, createRecognizer, evenStore, loadModel, transcribe } from 'even-g2-asr'

const bridge = await waitForEvenAppBridge()
// グラスの画面を作ってからでないとマイクを開けない。
await bridge.createStartUpPageContainer(/* … */)

const files = await loadModel(REAZONSPEECH_K2_V2, evenStore(bridge), p => console.log(p.phase, p.loaded / p.total))
const recognizer = await createRecognizer(files, ['箱根湯本', '北千住'])

const t = await transcribe(bridge, recognizer, {
  onPartial: text => console.log('途中', text),
  onLevel: rms => console.log(rms),
  onStop: () => console.log('録音が止まった'),
})
// タップで t.stop()、取り消しは t.cancel()。話し終えて 1.5 秒黙っても止まる。
console.log('確定', await t.final) // cancel したときは null
```

| 関数 | すること |
|---|---|
| `evenStore(bridge)` | Even App の保存領域を `KeyValueStore`（`get`・`set`、文字列だけ）にする。WebView の localStorage・IndexedDB・OPFS は origin のポートが起動ごとに変わるので次の起動で空になり、使えない。 |
| `loadModel(spec, store, onProgress?)` | store に揃っていれば戻し（`phase: 'restore'`）、無い・欠けている・spec が変わったときだけダウンロードする（`phase: 'download'`）。 |
| `isModelCached(spec, store)` | 揃っていると目録が言っているか。初回のダウンロードを始める前に確かめたいときに使う。 |
| `createRecognizer(files, hotwords, score = 1.5)` | Worker を立てて、その中に認識器を作る。`files` の配列の ArrayBuffer は Worker に移す（transfer、複製しない）ので、後で使わないこと。 |
| `recognizer.recognize(pcm)` | 16kHz mono、-1〜1 の `Float32Array` を文字にする（`Promise<string>`）。呼んだ順に1つずつ認識する。前後に 0.3 秒の無音を足してから渡す（無いと発話の頭の語を落とす）。 |
| `transcribe(bridge, recognizer, options?)` | `listen` で1発話を録りながら途中経過を `onPartial` に渡し、止まったら `final` に確定の文字を返す。`cancel()` なら `null`。オプションは `listen` のものに `onPartial` と `onStop` を足したもの。 |
| `listen(bridge, options?)` | マイクを開いて1発話を録る。`stop()`・話した後の無音（`silenceMs`、既定 1500）・上限（`maxSeconds`、既定 10）で止まり、マイクを閉じて購読を外してから `stopped` が解決する。`cancel()` なら `null`。録っている途中でも `recorded()` でそれまでの音声と最後に声だった位置を取れる。 |
| `s16leToFloat32(bytes)` | G2 のマイクが送る s16le を -1〜1 にする。 |

Node のスクリプト（Worker が無い）からは、`even-g2-asr/sherpa` の `createSherpa` で同じ認識器を呼んだスレッドの中に作れる（`recognize` は同期で `string` を返す）。`scripts/check-asr-routes.mjs` がこれを使う。

### 途中経過の出し方

`transcribe` は、声とみなせる音（`speechRms` 以上）が来てから、それまでの音声を丸ごと認識し直す。前の認識が終わってから次を始めるので認識は重ならず、端末が遅ければ途中経過の間隔が延びるだけで詰まらない。話している間は、前の認識から音声が 0.3 秒以上伸びたら次を始める。

認識に渡す音声は最後の声の 0.3 秒後で切る（gTTS の 10 本では、声の終わりちょうどで切っても全部の音声と同じ文字になった）。話の切れ目では、切れ目が 0.3 秒に届くまで待ってから認識する。こうしておくと、黙っている間は認識し直さず、無音で止まったときは最後の途中経過がそのまま確定になる（確定の認識に渡す音声と同じなので、精度は変わらない）。タップで話し終えてすぐ止めたときだけ、走っている認識を待ってから全体を認識し直す。1回の認識の音声は `maxSeconds`（既定 10 秒）までに収まる。

途中経過は確定と同じ設定（`modified_beam_search` と hotwords）で認識する。ネイティブの sherpa-onnx で測ると、greedy にしても hotwords を外しても計算は 1 割ほどしか減らなかった（RTF 0.034 → 0.030。重いのは encoder）。設定を変えないので、途中経過を確定にそのまま使える。

`listen` の購読は `bridge.onEvenHubEvent` で、SDK は購読ごとに window のイベントを足すので、アプリ側のタップの購読と並んで動く。声とみなす音の大きさ（`speechRms`、既定 0.02）は G2 の実機では確かめていない。黙っても止まらないときや、話している途中で止まるときはここを変える。

hotwords は tokens.txt にある文字だけで書いた語にする。無い文字は sherpa が飛ばすので、途中の文字が抜けた別の語として登録されてしまう。英字の続き（JR）は1文字ずつに分けて登録する。

## 導入

このリポジトリでは npm workspace で使っている。他のアプリでは `packages/even-g2-asr` を写すか、`"even-g2-asr": "file:../train-jp/packages/even-g2-asr"` のように依存に入れる。TypeScript のソースのまま配るので、Vite などの bundler で読む。`@evenrealities/even_hub_sdk` は使う側のものを使う（peerDependencies）。

### app.json

```json
{
  "name": "network",
  "desc": "初回だけ音声認識のモデル（約170MB）を取得します。",
  "whitelist": ["https://huggingface.co", "https://us.aws.cdn.hf.co"]
},
{
  "name": "g2-microphone",
  "desc": "グラスのマイクで音声を聞き取ります。音声は端末の中で文字にし、外へ送りません。"
}
```

モデルの URL は Hugging Face の commit を固定した `resolve` URL。`huggingface.co` は 302 で `us.aws.cdn.hf.co` へ転送する（2026-10-01 に curl でたどって確かめた。tokens.txt だけは `huggingface.co` の中で 307 する）。どちらも `Access-Control-Allow-Origin` を返す。転送先のホストは Hugging Face の都合で変わることがあるので、ダウンロードが失敗したら転送先を確かめて whitelist を直す。スマホのマイクにするなら `transcribe`（か `listen`）に `source: AudioInputSource.Phone` を渡し、`phone-microphone` の権限を足す。

### Vite

`createRecognizer` は `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` で Worker を立て、Worker が `wasm/asr.js` のグルーを読み、グルーは `new URL('asr.wasm', import.meta.url)` で WASM を読む。Vite はこの形を見て、ビルドでは `dist/assets/worker-<hash>.js` と `asr-<hash>.wasm` を出し、開発サーバーではそのまま配る。public に写す必要は無い。Worker を ES module として出すため、`vite.config.ts` に `worker: { format: 'es' }` を書く。WASM は 13.7MB で、`.ehpk` に入る。SharedArrayBuffer は使わない。

## 容量とメモリの目安

| | 大きさ |
|---|---|
| モデル | 169,180,699 バイト（encoder int8 154.7MB、decoder 11.8MB、joiner int8 2.7MB、tokens.txt 46KB） |
| 保存領域 | base64 で 225,575,245 文字。約1MB ずつ 217 キー（`even-g2-asr/<id>/<file>/<n>`）と目録（`even-g2-asr/manifest`） |
| WASM | 13.7MB（`.ehpk` に入る） |
| WASM のメモリ | 認識器を作った後で 260MB |

デスクトップの Chromium（COOP/COEP なし）で測った値。ダウンロード 10.1 秒（回線による）、IndexedDB に置いた偽の保存領域からの復元 1.0 秒、認識器の作成 1.2 秒（hotwords 8,627 語）、3.3 秒の発話の認識 0.35 秒前後。タブのプロセスの RSS は、ダウンロード中に約 490MB、復元の後に約 430MB、認識器を作るところで約 740MB が最大だった（起動直後は約 170MB）。iPhone の WebView では WASM のメモリを 1,920MB まで取れることを確かめてある。

途中経過の速さは、gTTS の「○○から××まで」10 本（2.8〜3.3 秒）を 0.1 秒ずつ実時間で流して測った（Bun の Web Worker の中で認識。Bun の JavaScript エンジンは iPhone の WebView と同じ JavaScriptCore）。遅い端末の代わりに、cgroup の CPUQuota で CPU を 1/2、1/4 に絞った。中央値（括弧は最大）。

| CPU | 声の出始めから最初の文字 | 途中経過の間隔 | 無音で止まってから確定 | 話し終えて 0.3 秒後のタップから確定 |
|---|---|---|---|---|
| そのまま | 0.18 秒（0.34） | 0.35 秒（1.2） | 0 秒（0） | 0.03 秒（0.14） |
| 1/2 | 0.31 秒（0.80） | 0.60 秒（1.3） | 0 秒（0.29） | 0.51 秒（1.1） |
| 1/4 | 0.72 秒（1.7） | 1.1 秒（2.5） | 1.1 秒（1.4） | 1.7 秒（2.2） |

10 本とも、確定の文字は録った音声を1回で認識した文字と同じだった。止まってから全部の音声を1回で認識する作り（以前の作り）では、止まってから確定まで、無音で止まると 0.54 / 1.1 / 2.2 秒、タップで止めると 0.44 / 0.89 / 1.8 秒（中央値、CPU そのまま / 1/2 / 1/4）。

シミュレータ（WebKitGTK）では、準備が終わった後のアプリの WebKitWebProcess（Worker を含む）の RSS が約 880MB だった。録音して途中経過を認識している間に増えたのは約 40MB。

ダウンロードでは配列に書きながら sha256 を分けて計算し（`crypto.subtle.digest` は配列を一度に受け取って複製もするので、150MB の encoder ではメモリのピークが上がる）、約1MB ごとに base64 にして保存する。復元はファイルの大きさの配列を先に取り、1キーずつ読んで書き込む。base64 の文字列を溜めない。

`loadModel` は、すべてのファイルを落として sha256 を確かめ書き終えてから目録に `complete` を立てる。途中で落ちても、次の呼び出しで取り直して揃う。spec の id や中身が変わったら、前のモデルのキーを空文字で上書きしてから取り直す（保存先に削除が無いため）。復元ではキーの有無と長さだけを確かめ、sha256 は確かめない（毎回の起動で 170MB をハッシュしないため）。

## WASM を作り直す

```bash
npm run build:wasm -w even-g2-asr
```

`wasm/build.sh` が emsdk 4.0.23 と sherpa-onnx v1.13.8 を `/tmp/even-g2-asr-build`（`WORK=` で変えられる）に取ってきて、`wasm/asr.{js,wasm}` を作る。git、cmake、make が要る。Even App の WebView は `crossOriginIsolated` にならず SharedArrayBuffer を使えないので、pthread なしで作る。`wasm/asr.c` は認識の設定（offline transducer、`modeling_unit=cjkchar`、`modified_beam_search`、`max_active_paths=4`）を C 側に固定する薄い層。

## テスト

```bash
npm test -w even-g2-asr
```

メモリ上の store と偽の fetch で、ダウンロードと復元、途中で落ちた状態からの回復、sha256 の不一致、spec の変更を確かめる。`listen` は偽の bridge で、止まり方とマイク・購読の後始末を確かめる。`transcribe` は偽の bridge と偽の認識器で、録音中に途中経過を返すこと、認識が重ならないこと、話の切れ目で待つこと、無音・stop で確定すること、cancel で `null` になること、認識の失敗で録音が止まることを確かめる。Worker（`recognizer.ts`）は Node では動かないので、テストには入れていない。

## ライセンス

- このパッケージ: MIT。
- sherpa-onnx: Apache-2.0。onnxruntime: MIT。どちらも `wasm/asr.wasm` に静的にリンクしている。
- モデル [reazon-research/reazonspeech-k2-v2](https://huggingface.co/reazon-research/reazonspeech-k2-v2): Apache-2.0。パッケージには入れず、使う人の端末が Hugging Face から取る。
