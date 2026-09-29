# x402 Interlock：タスク単位の予算と行動ゲート 実装指示書

> The owner's brief for the Colosseum "Crypto World's Fair" submission (deadline 2026-10-12),
> handed to Claude Code verbatim on 2026-09-29.

## 0. 前提

対象リポジトリ：https://github.com/kato9292929/x402-Interlock
Colosseum「Crypto World's Fair」への提出を想定する。締切は2026年10月12日。
作業ブランチへのpushは可。PRの作成とマージは行わない。

### 設計の方針

タスクを予算の単位にする。タスクごとにSolanaの[Subscriptions & Allowances](https://solana.com/news/subscriptions-and-allowances)で委任を1つ作り、終わったら失効させる。

```
プログラムID  De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
リポジトリ    solana-program/subscriptions
稼働          mainnet / devnet。SPL Token と Token-2022 に対応
```

タスクそのものが委任状になる。 Interlock独自の委任状フォーマットと、その状態管理は実装しない。発行と失効はSolanaのプログラムへの呼び出しになる。

### 外せない条件

1. タスクの発行は人の承認を要する。 エージェントが自分でタスクを作れるなら、上限を使い切るたびに新しいタスクを開くだけで抜けられる。発行APIはエージェントの資格情報では呼べないようにする
2. Allowanceの委任先はゲートの鍵にする。 エージェントの鍵に委任すると、上限の範囲内でゲートを迂回できる
3. タスク単位の予算は暴走を検知しない。損失に上限を付けるだけである。 検知が要る場合は別の判定として分ける。READMEにもそう書く

### 前回までに確認済みのこと

- Solanaの標準RPCでは、過去のスロット時点のアカウント状態を取得できない。バリデータは前の版を保持しない
- したがって権限の状態は、署名の直前にゲートが照会し、その結果を台帳に固定する
- x402のSolana決済は、x402-Autonomous-Agentで`@x402/svm` 2.15.0、PayAI facilitator経由で実績がある

## 1. 作業の配分（14日）

```
1. Solana対応                       4日
2. タスクの発行・失効（Allowances）  3日
3. 行動の種類とポリシー              3日
4. 台帳と画面                        1日
5. デモと提出物                      3日
```

削ったもの：

- 台帳のハッシュをSolanaへ書き込む処理。Allowancesを使う時点でチェーン上に予算と委任の履歴が残るため、Solanaを使う理由はそれで立つ
- Interlock独自の委任状フォーマットと状態管理。タスク＝Allowanceにしたため不要
- 件数とレートの上限。暴走と正常な自走を判別できないため採用しない

## 2. Solana対応

- x402-Autonomous-Agentの`@x402/svm`を使った決済経路を、Interlockのゲートに移植する
- ゲートの判定部分（固定ルール、Intercepta、ASK_HUMAN）はチェーンに依存しないので、署名と決済のみ差し替える
- facilitatorはPayAIを使う
- 既存のBase経路は残す。設定で切り替えられるようにする
- 買い手の鍵はゲートのサーバーだけが持つ。既存の方針を踏襲する

Interceptaの検査は、Base mainnet基準で行う現在の方針を維持する。Solana側のアドレスを検査対象にできるかは確認し、できない場合はREADMEに明記する。

## 3. タスクの発行・失効

### API

```
POST   /api/tasks              発行。目的、上限、期限を受け取る
POST   /api/tasks/{id}/close   終了。Allowanceを失効させる
GET    /api/tasks/{id}         状態と使用額
GET    /api/tasks              一覧
```

- 発行と終了は、オーナー用の資格情報で保護する。`AGENT_TOKEN`では呼べないこと
- 発行時に、Solana上でAllowanceを1件作成する。委任先はゲートの鍵
- 終了時に、Allowanceを失効させる
- 失効は取り消せない。再開には新しいタスクを発行する

### タスクの内容

```json
{
  "task_id": "task_...",
  "purpose": "ミュージックビデオを1本作る",
  "budget": { "amount": "10.00", "asset": "USDC" },
  "expires_at": "2026-10-13T00:00:00Z",
  "allowance": {
    "pubkey": "...",
    "delegate": "ゲートの鍵のpubkey"
  },
  "status": "active"
}
```

### 署名直前の照合

既存の判定に、タスクの照合を追加する。

```
1. task_id が指定されているか        → 無ければ BLOCK
2. タスクが active か                 → 終了済みなら BLOCK
3. 期限内か                           → 過ぎていれば BLOCK
4. Allowance の状態を照会             → 失効していれば BLOCK
                                        照会できなければ BLOCK（fail closed）
5. 残額が足りるか                     → 不足なら BLOCK
6. 以降、既存の Intercepta 検査と行動ポリシー
```

照合は署名のたびに行う。起動時に読み込んで保持しない。照会したスロット番号、Allowanceのアドレス、アカウントデータを台帳に残す。

## 4. 行動の種類とポリシー

行動を4つに分類し、種類ごとにポリシーを持たせる。

```
pay         支払う。金額で測れる。予算で被害が閉じる
commit      合意や約束。値下げ、日時の確定、対面の約束
disclose    開示。住所、電話番号、認証情報
impersonate 本人として発言する
```

ポリシーは4つの値を取る。

```
allow        自動で許可
ask_human    人に聞く（World ID）
deny         禁止
notify       許可するが、事後に通知
```

既定値は次のとおりとし、設定ファイルで変更できるようにする。

```
pay          allow（タスクの予算内であれば）
commit       ask_human
disclose     ask_human
impersonate  deny
```

エージェントからの呼び出し口は、支払い以外も受けられるようにする。

```
POST /api/gate/evaluate
  { task_id, action_type, payload }
```

`action_type`が`pay`のときは既存の402処理を行う。それ以外は、ポリシーの判定と台帳への記録のみを行い、実際の実行はエージェント側に返す。Interlockが代行して投稿や送信を行うことはしない。

## 5. 台帳と画面

台帳に追加するイベント：

```
task_opened     タスクの発行。目的、上限、Allowanceのアドレス
task_closed     タスクの終了。失効のトランザクション
action_judged   支払い以外の行動の判定
```

既存のイベントに`task_id`を追加する。
画面は1つ足す。

```
/tasks   タスクの一覧と詳細。目的、上限、使用額、その中の判定履歴
```

## 6. デモ

3本撮る。

```
1. タスクの発行と支払い
   人がタスクを発行し、Allowanceが作られる
   エージェントがx402で複数回支払う。予算内は自動で通る
   予算を使い切ると止まる

2. Museの再現
   エージェントが住所を開示しようとする → ask_human で止まる
   値下げに合意しようとする → ask_human で止まる
   本人として発言しようとする → deny で止まる
   金額はどれもゼロ

3. タスクの終了
   タスクを終了させると Allowance が失効する
   その後の支払いが BLOCK になる
```

2本目が主題になる。金額では1件も止まらない事故が、行動の種類では止まることを見せる。

## 7. 検証

ネットワークを使わずに確認すること。

```
タスク
  AGENT_TOKEN ではタスクを発行できない
  終了したタスクでの支払いが BLOCK になる
  期限切れのタスクでの支払いが BLOCK になる
  Allowance を照会できない場合に BLOCK になる
  残額が不足する場合に BLOCK になる

委任先
  Allowance の delegate がゲートの鍵であることを検証している
  エージェントの鍵が delegate の場合に発行が失敗する

行動
  4種類それぞれで、ポリシーどおりの判定になる
  deny の行動が、人の承認を経ても通らない
  impersonate が既定で deny になっている

台帳
  task_opened / task_closed / action_judged がチェーンに入る
  既存イベントに task_id が付く
  Allowance の照会結果（スロット番号を含む）が残る
  秘密情報が残らない
```

Solanaを使うテストは、devnetの接続先が設定されている場合のみ実行する。設定がなければskipする。
既存のテストがすべて通ることも確認すること。

## 8. 実装しないこと

- 台帳のハッシュをSolanaへ書き込む処理
- Interlock独自の委任状フォーマットと状態管理
- 件数とレートの上限
- Jevによる判定（`task_fit`など）。READMEに今後の予定として書くにとどめる
- 支払い以外の行動の代行実行
- 本番環境へのデプロイ

## 9. 報告

日本語で次を報告すること。

- 変更・追加したファイル
- Allowancesの作成・照会・失効を、devnetで実際に動かせたか
- 照合を署名のたびに行っていることを、どう確認したか
- 実行したテストと結果
- 実装していない項目とTODO
- push先のブランチ

動作を確認していない項目を、動作済みと書かないこと。
