# World ID 4.0: sandbox verification API key

> The owner's brief, handed to Claude Code verbatim on 2026-09-26 (~18:30 JST).

World ID 4.0の仕様を調べた。実装は概ね正しいが、1点だけ確認と対応が要る。

## 確認できたこと（実装どおりで正しい）

- `rp_id`と署名鍵は、`app_id`とは別にDeveloper Portalで登録するRelying Partyのもの
- `signRequest({ signingKeyHex, action, ttl })`はローカル計算。署名を代行するAPIはプロトコルに存在しない。戻り値は`{ sig, nonce, createdAt, expiresAt }`
- 検証先は`POST https://developer.world.org/api/v4/verify/{rp_id}`で正しい（v3の`developer.worldcoin.org/api/v1/verify/{app_id}`から変更されている）

## 対応が必要なこと：sandbox検証にはAPIキーが要る

`environment`をリクエストで自由に指定できる脆弱性が修正され、stagingとsandboxでの検証には、アプリチームのAPIキーの提示が必須になった。本番（`environment`なし、または`production`）は認証不要のまま。
現在の`verifyApproval`は、`/api/v4/verify/{rp_id}`にAPIキーを付けずにPOSTしている。`WORLD_ENVIRONMENT=sandbox`の既定のままでは、検証が通らない可能性が高い。

次を実施すること。

1. `@worldcoin/idkit-core`および関連パッケージの型定義と実装を読み、sandbox/staging検証時にAPIキーをどのヘッダーで送るのが正しいかを特定する。特定できない場合は「不明」として報告し、推測で実装しない
2. `WORLD_API_KEY`（名前は特定した仕様に合わせる）を環境変数に追加し、`environment`がsandboxまたはstagingのときだけ送るようにする
3. 本番環境ではAPIキーを送らない分岐にする
4. APIキーが未設定でsandboxを指定した場合、起動時またはリクエスト前に分かりやすく落とすこと。検証が通らない理由が「APIキー不足」だと判別できるようにする
5. `.env.example`とREADMEを更新する

## 補足

- v4のRPは本番アプリにしか登録できない（stagingのアプリでは`register_rp`が拒否される）。オーナーはポータルで本番アプリを作り、その中でRPを登録する
- `WORLD_REQUIRE_USER_PRESENCE`や`WORLD_ACTION_PER_DECISION`の既定値は変更不要
