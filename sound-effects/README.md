# Magic Show Cue 効果音集

すべて低遅延再生向けの非圧縮WAVです。Magic Show Cueの効果音スロットでファイルを選択して使用してください。

| ファイル | 用途 | 推奨音量 |
|---|---|---:|
| `sfx_correct_pingpong.wav` | 正解・当たりの「ピンポーン」 | 90% |
| `sfx_wrong_buzzer.wav` | 不正解・外れのブザー | 75% |
| `sfx_magic_sparkle_reveal.wav` | コイン、カード、小物の出現や成功 | 85% |
| `sfx_magic_whoosh_appear.wav` | 大きな物の出現、変化、移動 | 75% |
| `sfx_magic_vanish_poof.wav` | 消失、煙、コミカルな「ポフッ」 | 75% |
| `sfx_magic_tada_sting.wav` | クライマックス、大成功、決めポーズ | 80% |

## おすすめの3スロット

1. 効果音1：`sfx_correct_pingpong.wav`
2. 効果音2：`sfx_wrong_buzzer.wav`
3. 効果音3：演目に合わせてマジック用4種類から1つ

形式は48kHz・16-bit PCM・モノラルです。BGMと同時に鳴らすことを考慮し、ピーク音量は-6～-8dBFSに抑えています。ページを再読み込みした場合、ブラウザの制限により音声ファイルを再選択してください。

`generate_magic_sfx.py` は同じ効果音を再生成するためのスクリプトです。既存WAVを保護するため、通常実行では上書きしません。
