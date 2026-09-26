# x402 Interlock：実APIへの適合と検証 実装指示書

> The owner's second brief, handed verbatim to Claude Code on 2026-09-26 ~15:15 JST.

対象リポジトリ：https://github.com/kato9292929/x402-Interlock

現状：実装は一通り完了し、41テストが通っている。ただしIntercepta・World ID・Base Sepoliaのいずれも実物では未検証である。本指示書は、実APIの仕様に合わせる修正と、実検証までを対象とする。

## 0. 方針

- **スクリーニングはすべてBase mainnet（chainId 8453）基準で行う。** Interceptaのリスクデータはmainnetのものであり、テストネットのアドレスを検査しても意味がないため。決済はBase Sepoliaのままでよい。この非対称は意図的な設計であり、READMEに1行で説明する
- 動作を確認していないものを、確認済みとして書かない
- 実検証はオーナーのMacで行う。コンテナからは外部に出られない

## 1. Interceptaの呼び出しを公式仕様に合わせる

現在の実装は、他チームのリポジトリから推測した仕様に基づいている。公式ドキュメントは `https://docs.web3antivirus.io/reference/` にある。

### 1-1. Scan Message（仕様確定済み）

```
POST https://api.web3antivirus.io/api/public/v2/extension/analysis/signature

body:
  from      必須  string  署名者のアドレス
  message   必須  json    EIP-712のペイロード（domain, types, primaryType, message）
  website   任意  string  処理が行われる文脈のURL
  chainId   任意  string  列挙型。既定は1。Base mainnetは8453（84532は選択肢にない）
```

- x402のexactスキームが使うEIP-3009 `transferWithAuthorization` は、このEIP-712形式のまま渡す
- `chainId`は`8453`で固定する
- 応答に含まれるもの：検出したメッセージ種別、`riskGroup`、関与するアドレスのラベルとリスク、危険な動作の検出結果

### 1-2. 残り3つの呼び出し

公式ドキュメントの該当ページと実装を突き合わせ、パス・パラメータ・応答の形の差分を報告してから修正する。

| 呼び出し | ドキュメント |
|---|---|
| Quick Scan Address | `/reference/quick-scan-address` |
| Deep Scan Address | `/reference/scan-address` |
| Scan Token | `/reference/scan-token` |

コンテナから`docs.web3antivirus.io`に到達できない場合は、ページの内容をオーナーに依頼して貼ってもらう。推測で実装を変えない。

### 1-3. 根拠の差し替え

コード内のコメントとREADMEで、仕様の根拠として他チームのリポジトリを参照している箇所を、公式ドキュメントのURLに差し替える。

## 2. 判定閾値の見直し

現在の`config/screening.json`は「toxicScoreが1以上、または特徴が一つでも出たらBLOCK」という仮置きである。

- `https://docs.web3antivirus.io/reference/scam-and-risk-library` にあるリスクの定義を読み、`riskGroup`と各検出結果の意味を確認する
- BLOCKの根拠に使う項目を選び直し、設定ファイルに反映する
- **選んだ理由を`config/screening.json`のコメント、またはREADMEに書く。** 「公式の推奨閾値が見つからないため厳しめにした」という記述が残っているなら、確認した内容に更新する
- 迷う場合は厳しい側（BLOCK寄り）のままにしてよい。ただしデモのシナリオ1（安全な支払いが通る）が成立することを必ず確認する

## 3. mainnet基準のスクリーニング対象を設定に分離

決済はBase Sepolia、スクリーニングはmainnetという構成を、設定として明示する。

- `config/policy.json`に、スクリーニング対象のmainnetアドレスを持たせる（例：`screening.seller_mainnet`、`screening.risky_mainnet`）
- 決済に使うテストネットのアドレスと、検査に使うmainnetのアドレスを、コード上で取り違えない構造にする
- allowlistの照合対象がどちらなのかを、READMEに明記する
- 現在ゼロアドレスが入っているallowlistは、環境変数から読むか、オーナーが差し替える前提で`.env.example`に記載する

## 4. 実検証（オーナーのMacで実行）

次のスクリプトと手順を、オーナーがそのまま実行できる状態にする。

```
npm run verify-live        # Intercepta 4呼び出し + facilitator + 残高
npm run dev
npm run agent -- quote     # PAY。txハッシュを表示
npm run agent -- risky     # BLOCK。理由を表示
npm run agent -- report    # ASK_HUMAN。承認1回、拒否1回
```

- `verify-live`は、4つの呼び出しそれぞれのHTTPステータスと応答本文の全文を表示し、`data/live-checks.jsonl`に時刻つきで保存する
- 判定ロジックは変更しない。結果の記録のみ行う
- World IDの承認・拒否は、スマホのWorld Appが必要なためMacで行う

## 5. 実APIの結果を反映

オーナーから実行結果を受け取ったら、次を行う。

- 応答の形が実装と違っていた箇所を修正する
- 修正が判定結果に影響する場合は、影響範囲を報告する
- READMEの「検証状況」を、確認済みと未確認に分けて更新する
- READMEのファイル・行リンクが、修正後の行番号と一致しているか確認する

## 6. 提出物の仕上げ

- `FEEDBACK.md`
  - Intercepta向け：最初の呼び出しが成功した時刻（`data/live-checks.jsonl`から）、分かりにくかった点、足りなかったもの、3〜5行
  - World向け：最初に成功するまでの時間、つまずいた点、足りなかった機能やドキュメント、一番効く改善案を1つ
- `docs/DEMO.md`：3シナリオのコマンドと期待する結果
- READMEに、判定の一覧（PAY / CAP / ASK_HUMAN / BLOCK の条件と理由コード）とCAPの定義（金額を減らせないため、安い選択肢に切り替える。なければBLOCK）を追記する

## 7. 優先順位

時間が足りない場合、上から順に守る。

1. World IDの承認・拒否が実際に通ること（$7,500の必須要件）
2. Interceptaの4呼び出しが実キーで通ること（$2,000の必須要件）
3. Base Sepoliaでの支払いが1件通ること
4. 1〜3の結果をREADMEとFEEDBACK.mdに反映すること
5. 閾値の見直しと設定の整理

## 8. 報告

各段階で次を報告する。

- 変更したファイル
- 公式ドキュメントと実装の差分（修正前・修正後）
- テストの結果
- 未検証のまま残っている項目
