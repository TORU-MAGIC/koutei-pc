# Magic Effect Remote

iPhoneのSafariとBluetoothリモコンで、マジック演技用効果音を低遅延再生する静的Webアプリです。ビンゴとBGM機能は含みません。

## iPhoneで使う

1. GitHub Pagesの公開URLをSafariで開く。
2. `音を準備する` をタップし、6スロットすべてが `準備完了` になるまで待つ。
3. BluetoothスピーカーとBluetoothボタンをiPhoneへ接続する。
4. 初期設定では音量 `＋` が効果音1、音量 `−` が効果音2。上部の `最後の入力` にキー名が表示されることを確認する。
5. 別の割り当てにする場合は `キーを登録` を押してから、割り当てるBluetoothボタンを1回押す。
6. 必要ならSafariの共有メニューから `ホーム画面に追加` する。

初回は通信できる場所で開いてください。Service Workerがアプリと20個のWAVをキャッシュするため、2回目以降は通信できない状態でも起動しやすくなります。本番前には必ず機内モード相当の状態でも一度確認してください。

音量＋／−が `VolumeUp`、`AudioVolumeUp`、`VolumeDown`、`AudioVolumeDown` としてSafariへ届けば自動再生します。ただしiPhoneが音量ボタンをOS側で処理すると、Webアプリには届かず使用できません。その場合は、`KeyA`、`Enter`、矢印キーなど通常のキーを送れるBluetoothキーボード型リモコンまたはフットスイッチが必要です。

音声はiPhoneが現在選択している出力先から鳴ります。Bluetoothスピーカーを接続していれば、そのスピーカーから再生されます。

## 公開内容

- `index.html`
- `effect-remote.css`
- `effect-remote.js`
- `pwa.js`
- `manifest.webmanifest`
- `service-worker.js`
- `sound-effects/` 内の20個のWAV

効果音名、音量、内蔵音の選択、キー割り当てはブラウザへ保存されます。自分で選んだカスタムWAV/MP3だけは、再読み込み後に選び直してください。
