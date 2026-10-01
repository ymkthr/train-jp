# even-g2-norikae

Even Realities G2 で見る乗換案内。スマホで出発駅と到着駅を入れると、グラスに経路を表示する。

## 画面

0. 駅の選択。入力した駅名に当たる駅が複数ある（高松は香川県・東京都・石川県）か、読みが近いだけの駅しか無いときに、「高松（香川県 JR高徳線）」のように都道府県と路線を添えて並べる。出発駅、到着駅の順に選ぶ。タップで選び、ダブルタップで入力待ちに戻る。
1. 候補一覧。出発・到着時刻、所要時間、乗換回数を並べる。タップで選ぶ。
2. 全体図。区間ごとに路線、行先、乗車時間、乗換の待ち時間を表示する。
3. 下端2行。今乗る電車と、次の乗換を表示する。
4. 途中駅。乗車中の区間で、次に停まる駅から先を表示する。

タップで 2 → 3 → 4 → 2 と切り替わる。ダブルタップで候補一覧に戻る。候補一覧でダブルタップするとアプリを終了する。

## データ

- 経路、時刻、途中駅、行先は [Transitous](https://transitous.org/) から取る。データ源は [transitous.org/sources](https://transitous.org/sources/) を参照。地図データは © OpenStreetMap contributors。駅は名前ではなく、座標の近くにある鉄道の停留所 ID で渡す（名前で geocode すると「松山」で台湾の松山、「西線16条」で西線6条を拾う。座標をそのまま渡すと、降りた駅から座標まで 15 分以内に歩けないときに、近くのバス停を経由する遠回りが返る）。
- 首都圏以外の路線名は [HeartRails Express](http://express.heartrails.com/) で補う。
- 読みの変換に [kuromoji.js](https://github.com/takuyaa/kuromoji.js)（Apache-2.0）と、同梱の辞書 mecab-ipadic-2.7.0-20070801（NAIST の著作権表示と ICOT Free Software の条件を付けて再配布できる。全文は `node_modules/kuromoji/NOTICE.md`）を使う。辞書（gzip のまま約 17MB）は `npm install` のときに `public/kuromoji` へ写し、パッケージに入れて端末内で読む。ネットには取りに行かない。`NOTICE.md` と `LICENSE-2.0.txt` も一緒に写す。
- 番線、運賃、遅延は表示しない。無料で使えるデータ源にないため。

Transitous の[利用方針](https://transitous.org/api/)に従い、このアプリはオープンソースかつ非商用で公開する。

## 開発

```bash
npm install
npm run dev
npm run simulate
```

Wayland 環境でシミュレータが `Error flushing display` で落ちる場合は、`WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GDK_BACKEND=x11` を付けて起動する。

### 音声認識の WASM

`public/sherpa/norikae-asr.{js,wasm}` は [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) を pthread なし・SIMD ありでビルドしたもの。Even App の WebView は `crossOriginIsolated` にならず SharedArrayBuffer を使えないため、単一スレッドで作っている。作り直すときは `npm run build:sherpa` を実行する（emsdk と sherpa-onnx を `/tmp/norikae-sherpa-build` に取ってくる。場所は `WORK=` で変えられる）。版と設定は `sherpa-wasm/build.sh` にある。

モデルは [reazon-research/reazonspeech-k2-v2](https://huggingface.co/reazon-research/reazonspeech-k2-v2)（Apache-2.0）の `encoder-epoch-99-avg-1.int8.onnx`・`decoder-epoch-99-avg-1.onnx`・`joiner-epoch-99-avg-1.int8.onnx`・`tokens.txt` を使う。パッケージには入れず、`src/asr/recognizer.ts` の `createRecognizer` にバイト列で渡す。

### 駅名の解決

`src/asr/stations.json` は駅の一覧。駅名（`name`）、都道府県（`pref`）、路線の1つ（`line`）、座標（`lat`・`lon`）、読み（`kana`）、hotwords に登録する表記（`aliases`）を持つ。HeartRails が路線ごとに返す行を、同じ名前で 3km 以内なら1駅にまとめ、離れた同名の駅（高松の香川県・東京都・石川県）は別の駅にする。路線の多い駅から順に並べ、候補もこの順に出す。作り直すときは `npm run build:stations` を実行する。取ってきたデータは `/tmp/norikae-stations` に置いて次から使う（場所は `WORK=` で変えられる。消すと取り直す）。

`src/asr/stations.ts` の `resolveStation`（駅名1つ）と `resolveRoute`（「○○から××まで」）は、音声認識の結果もスマホで入力した駅名も同じ手順で駅の候補にする（`npm test` で確かめる）。前後の「えっと」「駅まで」「お願い」などは無視する。

1. 駅名・別名の完全一致。漢字で書かれていれば、同じ読みでモデルが書けない字を含む駅（等々力 → 驫木）も候補に足す。仙台と川内のようにどちらも書ける同音の駅は足さない（主要駅の多くで選択画面が出てしまう）。
2. kuromoji で読みに直し、駅の読みと完全一致（西千十六条 → 西線16条）。同じ読みの駅はすべて候補にする。
3. 読みか表記のあいまい一致。編集距離を長い方の文字数で割った値が 0.34 以下の駅を近い順に候補にする（濁点だけの違いは半分に数える）。1件でも確定せず選ばせる。

候補は6件まで。1km 以内の駅（札幌とさっぽろ）は1つにする。1件に確定しなければグラスで選ばせる。

別名は、モデルが書ける文字（`tokens.txt`）だけで書けるものを生成時に選ぶ。モデルは数字を出さないので漢数字にし（北12条 → 北十二条）、英字は読みのカタカナも足す（JR → ジェイアール）。「（…）」付きの駅は括弧の中を言わない形と続けて言う形にする。`tokens.txt` に無い漢字（杁・椥・弗・艫・驫・擶）を含む駅は、その字だけかなにした形（ナギ辻）と、駅名全体のひらがなの読みにする。

- 駅名・都道府県・路線・座標: [HeartRails Express](http://express.heartrails.com/) の路線・駅名 API。
- 読み: [Wikidata](https://www.wikidata.org/)（CC0）の P1814（name in kana）。同名の駅は座標で見分ける。Wikidata に読みが無い駅は [日本語版 Wikipedia](https://ja.wikipedia.org/)（CC BY-SA 4.0）の記事冒頭の読み、それも無ければ kuromoji で駅名から作った読み。
- 使える文字: reazonspeech-k2-v2 の `tokens.txt`（Apache-2.0）。

実際の音声で確かめるには、`node scripts/check-asr-routes.mjs --list` が出す文を TTS で `<出発>_<到着>.wav`（16kHz mono 16bit）にして、`node scripts/check-asr-routes.mjs <モデルのディレクトリ> <音声のディレクトリ>` を実行する。public/sherpa の WASM で、hotwords なしと全駅の hotwords ありの両方で認識する。
