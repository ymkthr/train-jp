# Train JP

Train JP は、Even Realities G2 で使う日本の電車の乗換案内アプリです。出発駅と到着駅を音声で伝えると、乗る電車と乗り換えをグラスに表示します。

## 画面

### 検索

出発駅と到着駅を音声で入力し、必要なら駅を選ぶ。

<table>
  <tr>
    <td align="center"><strong>入力待ち</strong><br><img src="docs/screenshots/1-idle.png" width="100%" alt="入力待ち"></td>
    <td align="center"><strong>音声検索</strong><br><img src="docs/screenshots/2-voice.png" width="100%" alt="音声検索"></td>
  </tr>
  <tr>
    <td align="center"><strong>駅の選択</strong><br><img src="docs/screenshots/3-pick.png" width="100%" alt="駅の選択"></td>
    <td align="center"><strong>検索中</strong><br><img src="docs/screenshots/4-searching.png" width="100%" alt="検索中"></td>
  </tr>
</table>

### 経路を選ぶ

候補から経路を選び、全体の流れを確認する。

<table>
  <tr>
    <td align="center"><strong>候補一覧</strong><br><img src="docs/screenshots/5-list.png" width="100%" alt="候補一覧"></td>
    <td align="center"><strong>全体図</strong><br><img src="docs/screenshots/6-overview.png" width="100%" alt="全体図"></td>
  </tr>
</table>

### 乗降時間

乗車中は、残り時間、次の乗り換え、途中駅を確認できる。降りる駅が近づくと知らせる。

<table>
  <tr>
    <td align="center"><strong>下端2行</strong><br><img src="docs/screenshots/7-strip.png" width="100%" alt="下端2行"></td>
    <td align="center"><strong>途中駅</strong><br><img src="docs/screenshots/8-stops.png" width="100%" alt="途中駅"></td>
  </tr>
  <tr>
    <td align="center"><strong>降りる駅の知らせ</strong><br><img src="docs/screenshots/9-notice.png" width="100%" alt="降りる駅の知らせ"></td>
    <td></td>
  </tr>
</table>

## データの出典

- 経路は [Transitous](https://transitous.org/sources/)（© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors）
- 路線名は [HeartRails Express](http://express.heartrails.com/) から取得
