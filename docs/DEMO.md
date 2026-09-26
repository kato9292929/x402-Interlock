# Demo

Run on the owner's Mac (the World ID steps need World App on a phone).

## Before recording

```bash
cp .env.example .env.local   # fill in every value
npm install
npm run verify-live          # all four Intercepta calls should answer 2xx; check data/live-checks.jsonl
# verify-live makes ~7 Intercepta calls; skip it right before recording to stay under the rate limit.
# .env.local: WORLD_ENVIRONMENT=production, WORLD_REQUIRE_USER_PRESENCE=0 (the defaults).
npm run dev                  # keep running; open http://localhost:3000 (timeline)
```

Each scenario below uses a fresh `RUN_ID` so the run limit and the repurchase rule from one
scenario do not affect the next:

```bash
export RUN_ID=demo-$(date +%H%M)
```

## Scenario 1: safe, small payment → paid

```bash
npm run agent -- quote
```

Expected:
- the agent prints the 402 option (10000 = 0.01 USDC on `eip155:84532`)
- `[gate] PAY WITHIN_POLICY -> PAID`
- `[agent] settlement tx: 0x…` with a Base Sepolia basescan link
- timeline: a green **PAY / Paid** card. Intercepta shows `quick_scan_address`, `scan_token` and `scan_message`, each SAFE, screened as the mainnet addresses

## Scenario 2: Intercepta flags the payee → stopped

```bash
npm run agent -- risky
```

Expected:
- `[gate] BLOCK SCREENING_RISKY -> BLOCKED`
- `[agent] not paid (BLOCKED)`
- timeline: a red **BLOCK / Stopped** card. Under Intercepta, the address scan of `RISKY_MAINNET_ADDRESS` (a Garantex address) shows `sanction_address` and `blacklist`
- nothing is signed and no transaction is sent

## Scenario 3: high-value payment → owner must approve with World ID

### 3a. Approve

```bash
npm run agent -- report
```

Expected:
- `[gate] ASK_HUMAN ABOVE_HUMAN_THRESHOLD -> AWAITING_HUMAN` and an approval URL
- open the URL: the page shows payee, 0.8 USDC, the resource, the agent's stated purpose, and a countdown
- click **Approve with World ID**, scan the QR code with World App, and confirm
- the page shows **Approved and paid**; the agent prints `-> PAID` and a tx hash
- timeline: `human_verification` APPROVED (credential `proof_of_human`), then `payment_result` PAID

### 3b. Reject

Use a new run so the repurchase rule doesn't add a second reason:

```bash
RUN_ID=demo-reject-$(date +%H%M) npm run agent -- report
```

- open the URL and reject: either in World App or with the **Reject** button
- the page shows **Rejected: not paid**; the agent prints `-> HUMAN_REJECTED`, `not paid`
- timeline: `human_verification` REJECTED, then `payment_result` NOT_EXECUTED

Note: 3b is a repurchase of the same resource within 10 minutes of 3a, so its reason codes
also include `REPURCHASE_IN_WINDOW`. That is expected.

## Optional

```bash
npm run agent -- dataset                     # CAP: pays the 0.40 option instead of 2.00 (then ASK_HUMAN is not needed)
npm run agent -- report --cancel-after 20    # agent gives up → HUMAN_CANCELLED
# wait out the countdown on an approval page → HUMAN_EXPIRED
```
