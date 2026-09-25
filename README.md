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

| What | Where |
|---|---|
| HTTP call to the Intercepta API (`X-API-KEY`) | [`lib/intercepta.ts#L27`](lib/intercepta.ts#L27) |
| Quick Scan Address (payTo) | [`lib/intercepta.ts#L105`](lib/intercepta.ts#L105) |
| Deep Scan Address (payTo, used above `deep_scan_above`) | [`lib/intercepta.ts#L114`](lib/intercepta.ts#L114) |
| Scan Token (is this the real USDC?) | [`lib/intercepta.ts#L123`](lib/intercepta.ts#L123) |
| Scan Message (the TransferWithAuthorization about to be signed) | [`lib/intercepta.ts#L134`](lib/intercepta.ts#L134) |
| Mainnet mapping + aggregation | [`lib/screening.ts#L67`](lib/screening.ts#L67) |
| Called from the gate, before any signing | [`lib/gate.ts#L100`](lib/gate.ts#L100) |

**Fail-closed policy.** If Intercepta does not answer, answers with a non-2xx status, or answers
with a body the gate cannot interpret, that check is `UNAVAILABLE` and the payment is **BLOCKed**
(`SCREENING_UNAVAILABLE`). There are no mock or default "safe" values anywhere in the runtime path.
If a payment cannot be screened, it is not made.

**Mainnet screening for a testnet payment.** Intercepta's risk data covers mainnet only. Payments
settle on Base Sepolia, so [`config/screening.json`](config/screening.json) maps each network and
asset to its mainnet counterpart: Base Sepolia maps to Base (8453), and Base Sepolia USDC maps to
Base USDC. The payTo EOA is screened as the same address on mainnet. An asset with no mapping
cannot be screened and is blocked. The raw Intercepta response for every check is saved in the
ledger as evidence. The API key is not.

### World ID (verification)

| What | Where |
|---|---|
| RP-signed request (`signRequest`, TTL) | [`lib/world.ts#L54`](lib/world.ts#L54) |
| **Server-side verification** | [`lib/world.ts#L98`](lib/world.ts#L98): nonce / action / environment ([L103](lib/world.ts#L103)), signal = this payment ([L112](lib/world.ts#L112)), World Developer API `POST /api/v4/verify/{rp_id}` ([L117](lib/world.ts#L117)), owner nullifier ([L143](lib/world.ts#L143)) |
| Four exits: approve / reject / expire / cancel | [`lib/gate.ts#L271`](lib/gate.ts#L271), [L293](lib/gate.ts#L293), [L253](lib/gate.ts#L253), [L299](lib/gate.ts#L299) |
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

## Fixed rules

[`config/policy.json`](config/policy.json), evaluated by [`lib/policy.ts`](lib/policy.ts) in this order:

1. Intercepta risky → `BLOCK` (`SCREENING_RISKY`); unavailable → `BLOCK` (`SCREENING_UNAVAILABLE`)
2. payTo not in `allowlist` → `BLOCK`
3. above `max_amount_per_payment` → `CAP`. An x402 `exact` payment cannot be partial, so CAP means paying a cheaper option the seller itself offered in `accepts` (e.g. the $0.40 sample instead of the $2.00 dataset). If there is none, the payment is `BLOCK`ed.
4. run total would exceed `max_amount_per_run` → `BLOCK`
5. above `ask_human_above`, or the same resource bought within `repurchase_window_minutes` → `ASK_HUMAN`
6. otherwise → `PAY`

Every decision returns an array of reason codes.

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
| `SELLER_PAY_TO` | Demo seller address. **Also add it to `allowlist` in `config/policy.json`.** |
| `RISKY_PAY_TO` | The risky demo address pinned in Intercepta's ETHGlobal Discord channel |
| `INTERCEPTA_API_KEY` | From intercepta.io/ethglobal |
| `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` | From developer.world.org (sandbox) |
| `AGENT_TOKEN` | Shared secret between the agent script and the gate API |

In the World developer portal, allow repeated verifications for the action
`interlock-approve-payment`: the owner approves many payments with the same action.

### Demo scenarios

```bash
npm run agent -- quote     # 1. safe, $0.01           → PAY, paid, ledger entry
npm run agent -- risky     # 2. flagged payTo          → BLOCK, Intercepta reason shown
npm run agent -- report    # 3. $0.80 > ask_human_above → ASK_HUMAN; open the printed URL,
                           #    approve (paid) or reject (not paid) with World ID
npm run agent -- dataset   #    $2.00 > per-payment cap → CAP to the $0.40 option
npm run agent -- report --cancel-after 30   # agent gives up → CANCELLED
```

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

To be honest about where things stand, since the project must not claim unverified features as done:

| Part | Status |
|---|---|
| Policy engine, ledger hash chain, redaction | Verified by unit tests |
| Gate flow: PAY / CAP / BLOCK / ASK_HUMAN, all four human exits, replay, wrong owner, fail-closed | Verified by the integration test with local stand-ins |
| Signing an x402 `exact` payload with the server-held key | Verified locally (real EIP-712 signature via `@x402/evm`) |
| UI (timeline, approval page) | Rendered and checked against a test ledger |
| Live Intercepta API | **Not yet verified.** Endpoint paths and response shapes are taken from secondary sources, because the vendor docs were unreachable from the build environment |
| Live World ID sandbox approval | **Not yet verified** |
| Live settlement on Base Sepolia via the x402.org facilitator | **Not yet verified** |

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
