# even-g2-norikae

Even Realities G2 で見る乗換案内。スマホで出発駅と到着駅を入れると、グラスに経路を表示する。

## 画面

1. 候補一覧。出発・到着時刻、所要時間、乗換回数を並べる。タップで選ぶ。
2. 下端2行。今乗る電車と、次の乗換を表示する。
3. 全体図。区間ごとに路線、行先、乗車時間、乗換の待ち時間を表示する。
4. 途中駅。乗車中の区間で、次に停まる駅から先を表示する。

タップで 2 → 3 → 4 → 2 と切り替わる。ダブルタップで候補一覧に戻る。候補一覧でダブルタップするとアプリを終了する。

## データ

- 経路、時刻、途中駅、行先は [Transitous](https://transitous.org/) から取る。データ源は [transitous.org/sources](https://transitous.org/sources/) を参照。地図データは © OpenStreetMap contributors。
- 首都圏以外の路線名は [HeartRails Express](http://express.heartrails.com/) で補う。
- 番線、運賃、遅延は表示しない。無料で使えるデータ源にないため。

Transitous の[利用方針](https://transitous.org/api/)に従い、このアプリはオープンソースかつ非商用で公開する。

## 開発

```bash
npm install
npm run dev
npm run simulate
```

Wayland 環境でシミュレータが `Error flushing display` で落ちる場合は、`WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GDK_BACKEND=x11` を付けて起動する。
