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
| HTTP call to the Intercepta API (`X-API-KEY`) | [`lib/intercepta.ts#L32`](lib/intercepta.ts#L32) |
| Quick Scan Address (payTo) · [ref](https://docs.web3antivirus.io/reference/quick-scan-address) | [`lib/intercepta.ts#L110`](lib/intercepta.ts#L110) |
| Deep Scan Address (payTo, above `deep_scan_above`) · [ref](https://docs.web3antivirus.io/reference/scan-address) | [`lib/intercepta.ts#L119`](lib/intercepta.ts#L119) |
| Scan Token (is this the real USDC?) · [ref](https://docs.web3antivirus.io/reference/scan-token) | [`lib/intercepta.ts#L128`](lib/intercepta.ts#L128) |
| Scan Message (the EIP-3009 TransferWithAuthorization about to be signed, as EIP-712) | [`lib/intercepta.ts#L161`](lib/intercepta.ts#L161), verdict from `riskGroup` [L141](lib/intercepta.ts#L141) |
| Testnet payTo → mainnet screening address | [`lib/policy.ts#L93`](lib/policy.ts#L93) |
| Screening on Base mainnet + aggregation | [`lib/screening.ts#L81`](lib/screening.ts#L81) |
| Called from the gate, before any signing | [`lib/gate.ts#L110`](lib/gate.ts#L110) |

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
| RP-signed request (`signRequest`, TTL) | [`lib/world.ts#L54`](lib/world.ts#L54) |
| **Server-side verification** | [`lib/world.ts#L98`](lib/world.ts#L98): nonce / action / environment ([L103](lib/world.ts#L103)), signal = this payment ([L112](lib/world.ts#L112)), World Developer API `POST /api/v4/verify/{rp_id}` ([L117](lib/world.ts#L117)), owner nullifier ([L143](lib/world.ts#L143)) |
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

## Which credential, and why it is enough

We request **`proof_of_human` (Orb) only**, with `require_user_presence` enabled, and no legacy proofs.

- **The question the gate asks is "is the agent's owner, a real person, present right now and
  approving this exact payment?"** It is not asking who the person is, how old they are, or
  what their nationality is. So passport, MNC and `identityCheck` attributes would collect data
  the decision does not use. They are left out on purpose.
- **Why not device / selfie?** The threat is an agent (or whoever controls it) approving its
  own spending. A device-level credential can be satisfied by software on a compromised
  phone. `proof_of_human` is the strongest assurance that a unique human made the proof.
- **Why `require_user_presence`?** A proof-of-human says someone is human. The presence
  check says that person is *there now*, which matters for approving a payment.
- **Why the owner and not just any human?** The action is stable per agent
  (`interlock-approve-payment`), so the same person always produces the same nullifier. The
  first approval pins the owner's nullifier (`data/owner.json`, or `WORLD_OWNER_NULLIFIER`).
  After that, a proof from anyone else is refused (`not_agent_owner`). Uniqueness for each
  payment comes from the RP nonce and the payment-bound signal, not from a new action per payment.

## Decisions

[`config/policy.json`](config/policy.json), evaluated by [`lib/policy.ts`](lib/policy.ts). Rules are checked top to bottom; the first BLOCK wins.

| # | Condition | Decision | Reason code |
|---|---|---|---|
| 1 | Intercepta flags payTo, token or message | `BLOCK` | `SCREENING_RISKY` |
| 1 | Intercepta cannot screen (no answer, non-2xx, unknown body, unclassified `riskGroup`, no mainnet mapping) | `BLOCK` | `SCREENING_UNAVAILABLE` |
| 2 | payTo not in `allowlist` | `BLOCK` | `PAYTO_NOT_ALLOWLISTED` |
| 3 | amount > `max_amount_per_payment`, and the seller offers a cheaper option within the cap | `CAP` | `PER_PAYMENT_LIMIT_CAPPED` |
| 3 | amount > `max_amount_per_payment`, and no cheaper option | `BLOCK` | `PER_PAYMENT_LIMIT_NO_CAP` |
| 4 | run total would exceed `max_amount_per_run` | `BLOCK` | `RUN_LIMIT_EXCEEDED` |
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
| `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` | From developer.world.org (sandbox) |
| `AGENT_TOKEN` | Shared secret between the agent script and the gate API |

In the World developer portal, allow repeated verifications for the action
`interlock-approve-payment`: the owner approves many payments with the same action.

### Demo scenarios

See [`docs/DEMO.md`](docs/DEMO.md) for the commands and the expected result of each.

### Live checks

```bash
npm run verify-live   # Intercepta (all 4 calls, raw status + body), facilitator support for
                      # Base Sepolia, buyer USDC balance; each result is timestamped in
                      # data/live-checks.jsonl
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

The project must not claim unverified features as done, so this table records exactly what has and has not been tested.

**Verified**

| Part | How |
|---|---|
| Policy engine, ledger hash chain, redaction | Unit tests |
| Gate flow: PAY / CAP / BLOCK / ASK_HUMAN, all four human exits, replay, wrong owner, fail-closed, mainnet-only screening inputs | Integration test with local stand-ins |
| Signing an x402 `exact` payload with the server-held key | Locally (real EIP-712 signature via `@x402/evm`) |
| UI (timeline, approval page) | Rendered against a test ledger |

**Not yet verified**

| Part | Notes |
|---|---|
| Intercepta Scan Message, live | Request body follows the official spec. The `riskGroup` values that pass or block are not classified yet (risk library page not read), so every message is currently BLOCKed |
| Intercepta Quick Scan / Deep Scan / Scan Token, live | Paths and response shapes not yet checked against the official reference pages |
| World ID sandbox approve / reject, live | Needs World App on the owner's phone |
| Base Sepolia settlement via the x402.org facilitator | Not yet run |

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
