# 07 — Agent Procurement Policy Engine の3製品をInterlockに実装する

> The owner's brief, received 2026-10-03, copied as given (Japanese). It implements the concept
> published on 2026-09-20 (https://note.com/x402inc/n/nb2c2f879a0c8): Spend Guard, Delivery Review
> and Procurement Router.
>
> Notes added while implementing (not part of the brief):
> - The brief names the endpoint `/v1/decisions` and the yes/no type `binary`. The official
>   TypeSafe JavaScript SDK (`@typesafe-ai/sdk` 0.6.0, published by typesafe.ai) uses
>   `POST /v1/systemone` and the type `noul`. The implementation follows the SDK. See
>   spec/01-ai-log.md.

## 0. この指示書の位置づけ

2026年9月20日に公開した Agent Procurement Policy Engine の構想を、x402 Interlockに実装する。新しい設計を起こすのではなく、構想どおりに作る。

```
x402 Spend Guard        購入の前に、依頼内容との適合性と重複を点検する
x402 Delivery Review    購入後の応答を、購入前の要求と照合して記録する
x402 Procurement Router 候補から今回の仕事に必要な調達先を選ぶ。「買わない」も候補
```

現在のInterlockが持っているのは、構想で「コードで強制する」と整理した側だけになる。

```
実装済み   残予算（Solana Allowances）、送金先の照合（Intercepta）、
           金額上限、署名、タスクの状態、文面の決定論的一致
未実装     意味判断。構想で Jev が担当するとした部分がすべて空
```

導入順序は構想どおりとする。Spend Guardの並走評価とDelivery Reviewの記録から始め、その記録でRouterを比較する。

## 1. 原則（構想から引き継ぐ。変更しないこと）

```
1  Jevに任せるのは意味判断のみ
   残予算・送金先・上限・許可リスト・署名はコードで強制し、Jevに変更させない
2  Jevのスコアは、既存の制御を省略する理由にならない
   モデルへ渡す前に禁止された提供者を除き、
   判定の後も実行直前に最新の残予算・価格・送金先・通貨・ネットワーク・有効期限を確認する
3  confidence 0.96 は「決済全体が96%安全」という意味ではない
   確率は回答の分布に基づく値であって、取引の安全性ではない
4  承認は、具体的な要求と支払条件に結びつける
   安い見積もりへの承認を、高い取引に使い回せないようにする
5  提供者が「最新」「高品質」と書いているだけでは購入の根拠にしない
   確認できる対象期間、取得済みデータの識別子、更新情報と一緒に扱う
6  タイムアウトは決済失敗を意味しない
   結果が不明な取引は保留で照合し、確認前の再支払いを避ける
7  全件に同じ検査をかけない
   キャッシュと固定ルールで処理できるものを先に除き、
   意味判断が必要な取引にだけモデルを使う
```

## 2. Jev呼び出し層

### 2-1. 着手前に仕様を確定させる

TypeSafeの公式ドキュメント（https://docs.typesafe.ai/introduction）で次を確認する。既にコンソールのアクセスがあるので、実際に1件叩いてレスポンスの形を確かめること。

```
エンドポイント   /v1/decisions（chat completions とは別系統）
リクエスト       state ＋ questions
質問の型         binary（真偽の確率）／ choice（候補からの選択）／ score（ルーブリック）
criteria         質問ごとの型固有の詳細。choice なら候補ラベルの集合
モデル           jev-latest（可動エイリアス）。検証後はバージョンを固定する
環境変数         TYPESAFE_API_KEY、TYPESAFE_BASE_URL
制約             ストリーミング非対応
```

返ってきた model 文字列は必ず台帳に残す。判定の再現性のために要る。

### 2-2. `lib/jev.ts`

```
callJev(state, questions, opts)
  タイムアウト 3秒、リトライ1回
  失敗・タイムアウト・スキーマ不一致はすべて UNAVAILABLE
  UNAVAILABLE のとき、判定は ASK_HUMAN へ倒す（fail-closed）
  model 文字列と各質問の確率値をそのまま返す
```

state に入れる値はすべてデータとして扱う。売り手の説明文、購入して得た本文、エージェントの申告は外部由来で、指示文が仕込まれうる。判定対象の値として構造化して渡し、プロンプトとして解釈させない。
予算残高のように、コード側で扱える情報は、判断に不要ならモデルへ送らない。

### 2-3. しきい値

`config/appe-thresholds.json` に出す。コードに直書きしない。初期値は暫定とし、4節の検証で決める。

## 3. Spend Guard（購入の前）

### 3-1. 何を見るか

構想のとおり、予算内に収まったことと、適切に使ったことは別という前提で、必要性と重複を見る。

```
拾いたい事象
  同じ情報を何度も買う
  無料のデータで足りるのに有料APIを呼ぶ
  安いサービスを選んだ結果、必要な情報が欠けて買い直す
```

### 3-2. state

```
task.purpose           タスク発行時に人が書いた目的
task.budget            総額・消費額・残額
candidate.url          購入先（パスまで）
candidate.description  402応答やカタログに書かれた売り手の説明
candidate.amount       今回の金額
candidate.coverage     説明から読める対象期間・対象範囲（取れる場合）
history                同一タスク内の既購入20件（url, amount, 取得済みデータの識別子）
```

### 3-3. questions

```
1  binary  この購入は task.purpose の達成に必要か
2  binary  この購入は history の既購入と重複しているか
3  choice  この購入の性質
           candidates: 目的に直結 / 補助的 / 目的と無関係 / 判断材料が足りない
```

### 3-4. 並走評価から始める（構想の「shadow mode」）

最初は支払いを止めない。通常どおり実行しながら、Spend Guardなら保留したはずの取引を記録する。

```
ledger に spend_guard_review を追加
  task_id, url, amount
  jev_model
  necessity_prob     質問1
  duplicate_prob     質問2
  nature             質問3
  would_have         none / ask_human / block（実際には止めていない）
```

### 3-5. 実際に判定へ反映する段階（並走評価の後）

```
質問1が 0.75以上 かつ 質問2が 0.50未満   → 既存判定のまま
質問1が 0.40〜0.75 または 質問2が 0.50以上 → ASK_HUMAN へ格上げ
質問1が 0.40未満 または 質問3が「目的と無関係」 → BLOCK
UNAVAILABLE                                 → ASK_HUMAN
```

既存の BLOCK を Jev が解除することはない。判定は厳しくする方向にのみ効かせる。
理由コードは `SPEND_GUARD_UNNECESSARY` / `SPEND_GUARD_DUPLICATE` / `SPEND_GUARD_UNAVAILABLE`。

## 4. 評価の指標（3-5へ進む前に必ずやる）

構想で挙げた4つを分けて測る。節約額だけを見ない。

```
不要な購入を減らせたか          would_have が ask_human / block だった件のうち、
                                人が「不要だった」と判断した割合
必要な購入を誤って止めなかったか  would_have が block だった件のうち、
                                人が「必要だった」と判断した割合
業務の完了率を維持できたか       タスクが目的を達成した割合
費用対効果                      判定費用（1件0.00003ドル）＋ 待ち時間 ＋ 人の確認の増加
```

単価の安い調達では、判定費用が節約額を上回りうる。原則7のとおり、キャッシュと固定ルールで処理できるものを先に除く。
検証セットは最低30件。必要・不要の両方を含める。しきい値の根拠を `config/appe-thresholds.json` にコメントで残す。

## 5. Delivery Review（購入の後）

### 5-1. 何を見るか

支払いの成否と、要求への適合は別という前提で記録する。支払いが完了して200が返っても、目的の情報が得られたとは限らない。

```
対象期間が違う
必須項目がない
期待した詳細度に届かない
空の配列、固定値、ダミー
```

Jevが判定できるのは渡された証拠の範囲である。内容が事実として正しいかは別の検証が要る。要求に合っていることと、正しいことを混同しない。

### 5-2. コードで照合するもの / Jevに渡すもの

```
コード   対象期間の一致、必須項目の有無、件数、本文のバイト数、HTTPステータス
Jev      説明文が依頼した論点に答えているか、充足度
```

### 5-3. state と questions

```
state
  request.purpose        購入時の要求
  candidate.description  購入前に提示されていた説明
  response.body          得た本文。32KBを超える場合は先頭32KBまで
  response.fields        コード側で抽出した必須項目の有無、対象期間
  response.latency_ms / size_bytes / status

questions
  1  binary  得た本文は、購入前の要求に答えているか
  2  choice  本文の実体
             candidates: 実データ / 空 / ダミーや固定値 / エラー文 / 判定不能
  3  score   要求に対する充足度 0〜10
```

### 5-4. 台帳

```
delivery_review
  task_id, tx, url, amount
  body_sha256          本文のハッシュ。本文そのものは残さない
  body_size, latency_ms
  fields_ok            コード側の照合結果
  jev_model
  answers_prob         質問1
  substance            質問2
  fulfillment_score    質問3
  policy_version       適用したポリシーのバージョン
```

### 5-5. 次の調達へ戻す

構想のとおり、単発の評価を普遍的な信用スコアにしない。どの用途・どの時点の結果だったかを残す。

```
同一URLで対象期間の不一致が続く → 再購入を保留、または ASK_HUMAN
同一URLの substance が「空」ばかり → Spend Guard の state に履歴として渡す
```

購入後の評価が低くても、完了した支払いは自動では取り消さない。返金や再提供は提供者との取り決めが要る。ここで担うのは再購入の制御と、問い合わせ時に出せる証拠の整理になる。

## 6. Procurement Router（Spend Guard と Delivery Review の記録が溜まった後）

### 6-1. 何を見るか

Spend Guardが個別の購入予定を点検するのに対し、Routerは複数の候補から、何を使えば依頼を満たせるかを選ぶ。

```
候補の入口     企業が登録したサービス一覧、エンドポイントのカタログ、
               API仕様、利用可能なMCPツール
候補に含める   無料データ、キャッシュ、既存契約のAPI、x402で都度購入するサービス
               「買わない」も候補に含める
```

MCPを必須経路にしない。異なる経路のサービスを、同じ購買判断に載せられることが要件になる。

### 6-2. MVPの範囲

構想のとおり、一つのデータ分野と少数の提供者に限定する。

```
コード   価格、対応形式、利用条件での絞り込み
Jev      候補が要求に合っているかの評価
出力     選んだ候補と、確定した価格・条件を Spend Guard と実行制御へ渡す
再評価   価格や取得範囲が選定時から変わった場合
```

比較するのは単価ではなく、要求を満たすまでの調達コストになる。ただし、それを正確に予測できると最初から約束しない。過去の取得結果、失敗率、追加取得の発生を蓄積して根拠を増やす。

## 7. 共通の取引記録

```
依頼内容と、購入によって満たしたい要件
選定したサービス、価格、対象範囲、利用条件
判断に使った証拠と、適用したポリシーのバージョン
モデルの評価、人による承認・却下、その理由
支払いの状態、取得した結果、要求への適合評価
```

## 8. 並行動作への対応

複数のエージェントが同時に動く場合、個々の判定が上限内でも合計で超える。

```
予算の予約・確定・解放を台帳側で管理する
再試行による二重購入を防ぐ
停止条件に、予算超過だけでなく、連続失敗と取引状態の不明を含める
結果が不明な取引は保留で照合し、確認前の再支払いを避ける
```

## 9. やってはいけないこと

```
Jevの判定で、既存の BLOCK を解除する
Jevに予算や権限を変更させる
提供者の「最新」「高品質」という記述を購入の根拠にする
単発の Delivery Review を、そのホストの信用スコアとして外部に出す
本文・宛先・登録済みの個人情報を台帳に書く
検証（4節）を飛ばして、しきい値を本番の判定に入れる
購入後の評価が低いことを理由に、完了した支払いを自動で取り消す
Local Jev や企業専用モデルへの蒸留を、提供機能として前提にする
```

## 10. 受け入れ基準

```
Spend Guard
  並走評価で spend_guard_review が記録され、実際の支払いは止まらない
  目的と無関係なURLで would_have が block になる
  同一タスク内で同じURLを再度渡すと duplicate_prob が上がる
  Jevを落とした状態で UNAVAILABLE が記録され、判定段階では ASK_HUMAN になる
  既存の BLOCK が Jev によって解除されない

Delivery Review
  空の配列を返すエンドポイントで substance が「空」になる
  対象期間の不一致がコード側の fields_ok で検出される
  台帳に本文が残っていない（全文検索で確認）
  同一URLの2回目に、過去の記録が Spend Guard の state に入っている
  評価が低くても、支払いが自動で取り消されない

Router
  候補に「買わない」が含まれる
  価格・条件での絞り込みがコード側で行われている
  選定後に価格が変わった場合、再評価が走る

共通
  jev_model と policy_version がすべての判定に記録されている
  しきい値が config/appe-thresholds.json から読まれている
  既存のテストが通る
```

## 11. 実装の順序

```
1  lib/jev.ts と config/appe-thresholds.json
2  Spend Guard の並走評価（3-1〜3-4）
3  Delivery Review の記録（5節）
4  4節の指標で検証。しきい値を決める
5  Spend Guard を判定へ反映（3-5）
6  Delivery Review の記録を Spend Guard の state へ接続（5-5）
7  Procurement Router の MVP（6節）
8  並行動作への対応（8節）
```

4を飛ばして5に進まないこと。構想のとおり、並走評価の記録と人の評価を比較してから判定に入れる。
各段階が終わったら、こちらが実行するコマンドを1行ずつ示すこと。devnetで実際に通してから次へ進む。
