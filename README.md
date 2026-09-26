# x402 Interlock

**A gate that sits right before an agent signs an x402 payment. It screens the payment with Intercepta, applies fixed spending rules, and, when the rules require it, asks the agent's owner to approve with World ID before anything is signed.**

ETHGlobal Tokyo 2026 · Building from Scratch track · Partner tracks: Intercepta (Safe Agent-to-Agent Payments with x402), World (Best Use of World ID for Agents)

```text
agent ── GET /api/seller/report ──▶ seller        402 + PAYMENT-REQUIRED
agent ── POST /api/gate/evaluate {url, purpose} ──▶ x402 Interlock (server)
          1. re-fetch the 402 itself (the agent's copy is not trusted)
          2. Intercepta: payTo (Quick/Deep Scan Address), token (Scan Token),
             the EIP-3009 authorization message (Scan Message)
          3. fixed rules from config/policy.json
          4. decision: PAY | CAP | ASK_HUMAN | BLOCK
          5. ASK_HUMAN → World ID proof_of_human, verified server-side
             approve → sign + pay · reject / expire / cancel → never signed
          6. every step appended to data/ledger.jsonl (hash chain)
```

The agent never holds a wallet key. The buyer key lives only on the Interlock server
([`lib/signer.ts`](lib/signer.ts)), and it signs exactly the payment requirement that the gate
approved, nothing else. An agent cannot sign around the gate, and a browser cannot approve a
payment by reporting "approved".

## Where the partner APIs are called

### Intercepta (required link)

Official reference: https://docs.web3antivirus.io/reference/

| What | Where |
|---|---|
| HTTP call to the Intercepta API (`X-API-KEY` header) | [`lib/intercepta.ts#L36`](lib/intercepta.ts#L36) |
| Quick Scan Address `GET …/account/{address}/quick-scan` · [ref](https://docs.web3antivirus.io/reference/quick-scan-address) | [`lib/intercepta.ts#L148`](lib/intercepta.ts#L148) |
| Deep Scan Address `GET …/account/{address}/toxic-score`, used above `deep_scan_above` · [ref](https://docs.web3antivirus.io/reference/scan-address) | [`lib/intercepta.ts#L157`](lib/intercepta.ts#L157) |
| Reading `ToxicScoreShortResponseV2` (both address scans) | [`lib/intercepta.ts#L72`](lib/intercepta.ts#L72) |
| Scan Token `GET …/token-intelligence/token/{address}/risks?chainId=8453` · [ref](https://docs.web3antivirus.io/reference/scan-token) | [`lib/intercepta.ts#L195`](lib/intercepta.ts#L195), reading `TokenRiskAnalysisV2Response` [L98](lib/intercepta.ts#L98) |
| Scan Message `POST …/analysis/signature` (the EIP-3009 TransferWithAuthorization about to be signed, as EIP-712) | [`lib/intercepta.ts#L230`](lib/intercepta.ts#L230), verdict from `riskGroup` [L210](lib/intercepta.ts#L210) |
| Testnet payTo → mainnet screening address | [`lib/policy.ts#L94`](lib/policy.ts#L94) |
| Screening on Base mainnet + aggregation | [`lib/screening.ts#L93`](lib/screening.ts#L93) |
| Called from the gate, before any signing | [`lib/gate.ts#L110`](lib/gate.ts#L110) |

### How Intercepta results are judged

Thresholds live in [`config/screening.json`](config/screening.json). Each check gives one of four
verdicts, and the worst one wins: `RISKY` → BLOCK, `UNAVAILABLE` → BLOCK, `CAUTION` → ASK_HUMAN,
`SAFE` → pass.

| Check | BLOCK | ASK_HUMAN | Pass |
|---|---|---|---|
| Quick / Deep Scan Address (`traits[].name`) | `known_scammer`, `sanction_address`, `sanction_address_communication`, `blacklist`, `fake_phishing_transfer`, `fake_phishing_contract_communication`, `initiator_scam_transactions`, `rug_pull`, `attack_money_target` | `mixer_transfers`, `non_kyc_transfers`, `suspicious_deployer`, `suspicious_dex_pair_deployer`, `zero_address_risk`, `rug_pull_trader` | no traits |
| Scan Token (`action`) | `block` | `warn` | `info` |
| Scan Message (`riskGroup`) | not classified yet: every value BLOCKs until real responses are classified | | |

Why these lines:

- **Address traits.** A trait tied directly to asset theft or sanctions (a known scammer,
  sanctioned or blacklisted address, phishing, rug pull, attack target) BLOCKs: paying such an
  address is the loss the gate exists to prevent. A suspicious but not conclusive trait (mixer
  or non-KYC flows, suspicious deployer, zero-address risk, rug-pull trader) goes to the owner,
  because it can also fit a legitimate counterparty. All 15 documented trait names are
  classified. A name outside the list is `UNAVAILABLE` and BLOCKs.
- **Token.** Scan Token returns the vendor's own recommended `action`, so the gate follows it as-is.
- **Caching.** Answered token scans are cached in-process per (chainId, token) for
  `token_cache_minutes` (default 10; 0 turns it off) ([`lib/intercepta.ts#L175`](lib/intercepta.ts#L175)).
  Address scans and Scan Message are never cached.
- **Rate limits.** An HTTP 429 makes that one check `UNAVAILABLE`, with reason
  `rate limit reached (HTTP 429): …`. Other checks keep their own verdicts, and the payment
  still BLOCKs (fail closed).
- **`toxicScore` is never used on its own.** The vendor publishes no threshold for it, so any
  cut-off we picked would be arbitrary. It is recorded in the ledger and shown on the timeline,
  but the verdict comes from `traits`.
- **Scan Message.** The docs do not list the values `riskGroup` can take. They will be
  classified from real `npm run verify-live` responses, using the risk library's three tiers
  (Critical risks, Moderate risks, Suspicious activity) to decide where BLOCK and ASK_HUMAN fall.
  Until then, an unclassified value BLOCKs (fail closed).

**Fail-closed policy.** If Intercepta does not answer, answers with a non-2xx status, or answers
with a body the gate cannot interpret, that check is `UNAVAILABLE` and the payment is **BLOCKed**
(`SCREENING_UNAVAILABLE`). A Scan Message `riskGroup` that is not classified in
[`config/screening.json`](config/screening.json) is also `UNAVAILABLE`. There are no mock or
default "safe" values anywhere in the runtime path. If a payment cannot be screened, it is not made.

**Screening runs on Base mainnet (8453) while payment settles on Base Sepolia, on purpose: Intercepta's risk data is mainnet-only, so a testnet address would tell it nothing.**
Each testnet payTo is mapped to the mainnet address screened in its place
(`screening.targets` in [`config/policy.json`](config/policy.json)), and Base Sepolia USDC to Base
USDC ([`config/screening.json`](config/screening.json)). The Scan Message payload is rebuilt with
mainnet values (chainId 8453, Base USDC contract, mainnet recipient). A payTo or asset with no
mainnet mapping cannot be screened and is blocked. In code, `TestnetAddress` and `MainnetAddress`
are separate types, so one cannot be passed where the other is expected. The raw Intercepta
response for every check is saved in the ledger, together with the mainnet addresses screened.
The API key is not saved.

### World ID (verification)

| What | Where |
|---|---|
| RP-signed request (`signRequest`, computed locally, TTL) | [`lib/world.ts#L85`](lib/world.ts#L85) |
| **Server-side verification** | [`lib/world.ts#L130`](lib/world.ts#L130): nonce / action / environment ([L135](lib/world.ts#L135)), signal = this payment ([L144](lib/world.ts#L144)), World Developer API `POST https://developer.world.org/api/v4/verify/{rp_id}` ([L155](lib/world.ts#L155)), owner nullifier ([L185](lib/world.ts#L185)) |
| Sandbox/staging API key (optional, never sent for production) | [`lib/world.ts#L30`](lib/world.ts#L30), 401/403 diagnosis [L168](lib/world.ts#L168) |
| Four exits: approve / reject / expire / cancel | [`lib/gate.ts#L282`](lib/gate.ts#L282), [L304](lib/gate.ts#L304), [L264](lib/gate.ts#L264), [L310](lib/gate.ts#L310) |
| IDKit widget (relays the proof only) | [`app/approve/[id]/approval-client.tsx#L101`](app/approve/%5Bid%5D/approval-client.tsx#L101) |

The browser only passes the IDKit result along. A payment is signed only after the server has
checked all of the following:

1. The request has not expired (TTL is enforced server-side; any read after `expires_at` closes it as EXPIRED).
2. `nonce` equals the nonce of the RP signature issued for **this** decision.
3. `action` and `environment` are the ones we asked for.
4. The credential is `proof_of_human`, and its `signal_hash` equals `hash(decision_id | network | asset | payTo | amount)`. A proof for one payment cannot approve a different payment.
5. The World Developer API returns `success: true` for the proof.
6. The nullifier belongs to the agent's owner (see below).

Reject, expire and cancel can only *prevent* a payment, so they need no proof. Approve is the only
path that ever leads to a signature. The first terminal state wins, so a late approval after a
reject or expiry is refused.

### World ID setup notes

- **RP registration.** `rp_id` and the signing key belong to a Relying Party registered in the
  Developer Portal, separate from `app_id`. World ID 4.0 RPs can only be registered in a
  **production** app (a staging app's RP registration is refused), so create a production app
  and register the RP inside it. The RP signature is computed locally with `signRequest`. No API
  signs it for us.
- **Environment: production.** Verifying in `sandbox` was refused live with
  `environment_not_allowed`, so `WORLD_ENVIRONMENT` defaults to `production`. Approvals are
  verified against production with no API key, which worked live on 2026-09-26.
- **Sandbox/staging API key (kept, unused by default).** We had been told that sandbox/staging
  verification requires the team API key. The official sources we checked on 2026-09-26 name no
  header for it (`openapi/developer-portal.json` has no `security` on
  `POST /api/v4/verify/{rp_id}`), so the key and its header are configuration
  (`WORLD_API_KEY`, `WORLD_API_KEY_HEADER`). They are sent only for sandbox/staging, never for
  production. A World 401/403 fails with `world_verify_unauthorized …`, and
  `npm run verify-live -- world` probes the endpoint.

## Which credential, and why it is enough

We request **`proof_of_human` (Orb) only**, with no legacy proofs. `require_user_presence` is
**off by default** (`WORLD_REQUIRE_USER_PRESENCE=0`).

- **The question the gate asks is "is the agent's owner, a real person, present right now and
  approving this exact payment?"** It is not asking who the person is, how old they are, or
  what their nationality is. So passport, MNC and `identityCheck` attributes would collect data
  the decision does not use. They are left out on purpose.
- **Why not device / selfie?** The threat is an agent (or whoever controls it) approving its
  own spending. A device-level credential can be satisfied by software on a compromised
  phone. `proof_of_human` is the strongest assurance that a unique human made the proof.
- **Why `require_user_presence` is off.** It adds a fresh face check in World App. In live testing
  (2026-09-26) that check failed in World App, and the approval never completed. Without it,
  "this person, now" still holds: every proof carries the RP nonce issued for this decision,
  expires with the request's short TTL (180 s by default), and must come from the pinned owner's
  nullifier. So a stale or replayed proof is still refused. Set `WORLD_REQUIRE_USER_PRESENCE=1`
  to turn the face check back on where World App supports it.
- **Why the owner and not just any human?** The action is stable per agent
  (`interlock-approve-payment`), so the same person always produces the same nullifier. The
  first approval pins the owner's nullifier (`data/owner.json`, or `WORLD_OWNER_NULLIFIER`).
  After that, a proof from anyone else is refused (`not_agent_owner`). Uniqueness for each
  payment comes from the RP nonce and the payment-bound signal, not from a new action per payment.

## Decisions

[`config/policy.json`](config/policy.json), evaluated by [`lib/policy.ts`](lib/policy.ts). Rules are checked top to bottom; the first BLOCK wins.

| # | Condition | Decision | Reason code |
|---|---|---|---|
| 1 | Intercepta flags payTo, token or message (BLOCK column above) | `BLOCK` | `SCREENING_RISKY` |
| 1 | Intercepta cannot screen (no answer, non-2xx, unknown body, unclassified value, no mainnet mapping) | `BLOCK` | `SCREENING_UNAVAILABLE` |
| 2 | payTo not in `allowlist` | `BLOCK` | `PAYTO_NOT_ALLOWLISTED` |
| 3 | amount > `max_amount_per_payment`, and the seller offers a cheaper option within the cap | `CAP` | `PER_PAYMENT_LIMIT_CAPPED` |
| 3 | amount > `max_amount_per_payment`, and no cheaper option | `BLOCK` | `PER_PAYMENT_LIMIT_NO_CAP` |
| 4 | run total would exceed `max_amount_per_run` | `BLOCK` | `RUN_LIMIT_EXCEEDED` |
| 5 | Intercepta finds something suspicious but not conclusive (ASK_HUMAN column above) | `ASK_HUMAN` | `SCREENING_CAUTION` |
| 5 | amount > `ask_human_above` | `ASK_HUMAN` | `ABOVE_HUMAN_THRESHOLD` |
| 5 | same resource bought within `repurchase_window_minutes` | `ASK_HUMAN` | `REPURCHASE_IN_WINDOW` |
| 6 | none of the above | `PAY` | `WITHIN_POLICY` |

**CAP.** An x402 `exact` payment cannot be partly paid, so CAP never reduces an amount. It switches
to a cheaper option that the seller itself listed in `accepts` (in the demo, the $0.40 sample
instead of the $2.00 dataset). If there is no such option, the payment is BLOCKed. A capped
payment that is still above `ask_human_above` becomes `ASK_HUMAN`, with both reason codes.

**Allowlist = testnet payTo.** `allowlist` is checked against the Base Sepolia address that is
actually paid, not against the mainnet screening address. By default it reads
`env:SELLER_PAY_TO`, so it needs no editing.

## Ledger

`data/ledger.jsonl` is append-only. Each line has `event_id`, `decision_id`, `occurred_at`,
`previous_event_hash` and `event_hash`, where `event_hash` is the SHA-256 of the canonical JSON
of the event. The event types are `payment_candidate`, `screening_result`, `gate_decision`,
`human_verification` and `payment_result`. Keys named like credentials (`apiKey`, `signature`,
`secret`, `private*`, `authorization`) are redacted before writing. RP signatures and the full
402 body are kept in separate files under `data/`, not in the ledger. The timeline page checks
the hash chain on every load.

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env.local     # fill in the values below
npm run dev                    # http://localhost:3000  (timeline)
```

| Variable | Notes |
|---|---|
| `BUYER_PRIVATE_KEY` | Base Sepolia test wallet holding test USDC. Server only. |
| `SELLER_PAY_TO` | Demo seller's **testnet** wallet (the allowlist reads it) |
| `RISKY_PAY_TO` | Testnet payTo of the "risky" demo seller (any wallet you control) |
| `SELLER_MAINNET_ADDRESS` | A clean **mainnet** address that Intercepta screens for the seller |
| `RISKY_MAINNET_ADDRESS` | The risky **mainnet** address pinned in Intercepta's ETHGlobal Discord channel |
| `INTERCEPTA_API_KEY` | From intercepta.io/ethglobal |
| `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` | From developer.world.org: a **production** app with an RP registered inside it |
| `WORLD_ENVIRONMENT` | `production` (default). `sandbox` is refused by World with `environment_not_allowed` |
| `WORLD_REQUIRE_USER_PRESENCE` | `0` (default). `1` adds World App's face check, which failed in live testing |
| `WORLD_API_KEY`, `WORLD_API_KEY_HEADER` | Optional. Sent only for sandbox/staging verification; set both or neither (see World ID setup notes) |
| `AGENT_TOKEN` | Shared secret between the agent script and the gate API |

In the World developer portal, allow repeated verifications for the action
`interlock-approve-payment`: the owner approves many payments with the same action.

### Demo scenarios

See [`docs/DEMO.md`](docs/DEMO.md) for the commands and the expected result of each.

### Live checks

```bash
npm run verify-live   # Intercepta (all 4 calls, raw status + body), World verify probe
                      # (is an API key required?), facilitator support for Base Sepolia,
                      # buyer USDC balance; each result is timestamped in data/live-checks.jsonl
```

### Tests

```bash
npm test          # policy, ledger, Intercepta parsing, World checks, full gate flow
npm run typecheck
```

`test/gate.integration.test.ts` runs the whole gate against local HTTP servers that stand in for
the seller, Intercepta and the World verify API, so every branch can be exercised offline. Those
stand-ins exist only in the test file. The application code always calls the real services.

## Status: what has been verified

Everything below was run, not just written. Live runs were on the owner's Mac on 2026-09-26
against the real services (Intercepta API, World ID production verify, Base Sepolia via the
x402.org facilitator). First successes (JST, from the local records):
Intercepta 19:01:16, first gate screening 19:14:08, first paid payment 19:26:07,
first verified World ID approval 19:49:44.

| Part | How | Result |
|---|---|---|
| Scenario 1: safe, small payment | Live | `quote` → `PAY WITHIN_POLICY` → `PAID`, tx [`0xd5f965ea346d1cb71d7c63f42df3c1ef4d83108dfe96e84da873b3f5bc080175`](https://sepolia.basescan.org/tx/0xd5f965ea346d1cb71d7c63f42df3c1ef4d83108dfe96e84da873b3f5bc080175). Scan Message answered `messageType=TransferWithAuthorization`, `riskGroup=Low` → SAFE |
| Scenario 2: flagged payee | Live | `risky` (screened as a Garantex address; traits `sanction_address`, `blacklist`) → `BLOCK SCREENING_RISKY`, not signed |
| Scenario 3a: owner approves with World ID | Live | `report` → `ASK_HUMAN` → World ID `proof_of_human` verified server-side → **Approved and paid** |
| Scenario 3b: owner rejects | Live | → `HUMAN_REJECTED`, not paid |
| Approval expires | Live | → **Expired: not paid** |
| Cancel, replay, wrong owner, CAP, run limit, repurchase, fail-closed, rate limit (429), token cache, mainnet-only screening inputs | Integration + unit tests (64) with local stand-ins | All pass |
| Ledger hash chain, redaction | Unit tests; the timeline checks the chain on every load | Pass |

Live findings that changed defaults:
- World `sandbox` verification is refused (`environment_not_allowed`), so the default is `production`.
- `require_user_presence` failed in World App, so the default is off (see "Which credential").
- The free Intercepta key hit its rate limit (HTTP 429). Token scans are now cached for 10 minutes; the demo used a second key.

## Starter kits and libraries

- **Next.js** via `create-next-app` (starter kit; commit `3fbf452` is the unmodified scaffold)
- `@x402/core`, `@x402/evm`, `@x402/next`: x402 protocol, buyer signing, seller middleware
- `@worldcoin/idkit`, `@worldcoin/idkit-core`: World ID request widget, RP signing, signal hashing
- `viem`: local account for signing
- `tsx`: running TypeScript scripts and tests

## How AI was used

This project was built with Claude Code (an AI coding agent), driven by the spec in
[`spec/00-instructions.md`](spec/00-instructions.md). Claude Code wrote the code in this
repository: `lib/`, `app/`, `scripts/`, `test/` and `config/`. The owner defined the product, the
rules and the demo, and ran the live tests. [`spec/01-ai-log.md`](spec/01-ai-log.md) lists which
files were generated when, and what was verified.
