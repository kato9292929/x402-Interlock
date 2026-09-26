# Intercepta official reference and screening thresholds

> Pasted by the owner on 2026-09-26 (~16:00 JST) from https://docs.web3antivirus.io/reference/ ,
> which was unreachable from the build container. Handed to Claude Code verbatim as the source of truth.

公式ドキュメントの内容が揃った。以下を正として、1-2と2を実施すること。

## Quick Scan Address

```
GET /api/public/v2/extension/account/{address}/quick-scan
認証: ヘッダー X-API-KEY
応答: ToxicScoreShortResponseV2
  toxicScore  number  ウォレットのリスク指標
  traits[]    risk(number) / name(enum) / txsCount(number) / description(string)
```

## Deep Scan Address

```
GET /api/public/v2/extension/account/{address}/toxic-score
認証: ヘッダー X-API-KEY
応答: Quick Scan と同一スキーマ（ToxicScoreShortResponseV2）
```

Quick Scanは低遅延向けの高速判定、Deep Scanはフィッシング、恐喝、窃取、ダークウェブ取引、資金洗浄、制裁フラグなどの関与を検査する。
`traits[].name`の取りうる値は次の15種類。

```
known_scammer                          initiator_scam_transactions
sanction_address_communication         suspicious_dex_pair_deployer
suspicious_deployer                    attack_money_target
zero_address_risk                      sanction_address
fake_phishing_transfer                 non_kyc_transfers
mixer_transfers                        fake_phishing_contract_communication
rug_pull                               rug_pull_trader
blacklist
```

## Scan Token

```
GET /api/public/v2/extension/token-intelligence/token/{address}/risks
query: chainId（任意、列挙型。Base mainnet は "8453"）
認証: ヘッダー X-API-KEY
応答: TokenRiskAnalysisV2Response
  riskScore  number（リスクの百分率）
  riskLevel  neutral | low | medium | high
  category   malicious | restricted | suspicious | availability | sanctioned | unverified | info
  trust      whitelist | blocklist | neutral
  action     block | warn | info   ← ベンダーが推奨する対応
  detectors[]  code / description
  saleTax / buyTax / token
```

## 閾値の設定（`config/screening.json`）

Scan Tokenには`action`という推奨対応がベンダーから返るので、これをそのまま使う。

```
Scan Token:
  action == "block"       → BLOCK
  action == "warn"        → ASK_HUMAN
  action == "info"        → 通過

Quick / Deep Scan Address:
  次の trait が1つでも出たら BLOCK（資産窃取・制裁に直結するもの）
    known_scammer
    sanction_address
    sanction_address_communication
    blacklist
    fake_phishing_transfer
    fake_phishing_contract_communication
    initiator_scam_transactions
    rug_pull
    attack_money_target
  次の trait は ASK_HUMAN（疑わしいが確定ではないもの）
    mixer_transfers
    non_kyc_transfers
    suspicious_deployer
    suspicious_dex_pair_deployer
    zero_address_risk
    rug_pull_trader
  traits が空 → 通過
```

`toxicScore`の数値そのものは、ベンダーが基準値を公開していないので、単独の判定根拠には使わない。台帳には記録し、画面に表示する。この方針をREADMEに書くこと。

## Scan Message の riskGroup

リスク定義のページに載っていたのは、危険の分類（Critical risks / Moderate risks / Suspicious activity）であって、`riskGroup`が返す値の一覧ではない。したがって分類は`verify-live`の実測で確定させる。それまでは現在の「未分類はBLOCK」を維持してよい。
参考として、リスク定義のページにある分類は次のとおり。ASK_HUMANとBLOCKの線を引く際の根拠に使える。

- Critical risks — フィッシングサイト、ウォレットドレイナー、ハニーポット、偽トークン、ウォッシュトレード、アドレスポイズニング、危険な承認、ゼロアドレス詐称、疑わしいデプロイヤーなど
- Moderate risks — ETHロック、隠れたミント、リエントランシー、委任呼び出し、アップグレード可能なコントラクトなど
- Suspicious activity — テロ資金供与、詐欺、資金洗浄（Mixer）、制裁、ランザムウェア、フィッシング、窃取、ダークネットなど

## 作業

1. Quick / Deep / Scan Tokenの実装を上記の仕様に合わせる。パス、認証ヘッダー（`X-API-KEY`）、応答の読み取りを確認する
2. `config/screening.json`を上記の分類で埋める。選定の根拠（`action`はベンダー推奨、traitは資産窃取・制裁に直結するものをBLOCK）をREADMEに書く
3. Scan Messageの`riskGroup`は未分類のままにし、`verify-live`で実測値が出たら埋める
4. `toxicScore`を単独の判定根拠にしない方針をREADMEに書く
5. テストを更新して報告する
