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

## Colosseum build: per-task budgets on Solana and the action gate

> Built for Colosseum "Crypto World's Fair" (brief: [`spec/06-tasks-and-action-gate.md`](spec/06-tasks-and-action-gate.md)).
> The ETHGlobal flow above (Base Sepolia, no task) is unchanged and still works.

**A task is the unit of budget, and a task is a Solana Allowance.** When the owner opens a task
("make one music video, 1.00 USDC, until tomorrow"), Interlock creates one Fixed delegation in the
Solana [Subscriptions & Allowances](https://solana.com/news/subscriptions-and-allowances) program
(`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, SDK `@solana/subscriptions`). The owner is
the delegator, the gate's key is the delegatee, the amount is the budget and the expiry is the
deadline. Closing the task revokes the Allowance on chain. Interlock has no delegation format of
its own. The ledger records that a task was opened and closed, and the remaining budget is always
read from the chain.

### Three rules that make it hold

1. **Only the owner can open a task** ([`lib/http.ts#L23`](lib/http.ts#L23)).
   `POST /api/tasks` and `/close` need `OWNER_TOKEN`. The agent's `AGENT_TOKEN` gets 401. If both
   tokens are the same, nobody is authorized. An agent that could open tasks could open a new
   budget whenever one ran out.
2. **The delegate is the gate's key, never the agent's**
   ([`lib/tasks.ts#L72`](lib/tasks.ts#L72), [check L129](lib/tasks.ts#L129)).
   Issuance refuses if the gate key equals `AGENT_SOLANA_ADDRESS`. After creating the Allowance, it
   reads it back from chain and checks delegatee, delegator, mint, amount and expiry. On any
   mismatch it revokes the Allowance and fails. An allowance delegated to the agent would let it
   spend within the limit without passing the gate.
3. **A task budget caps the loss. It does not detect a runaway agent.** An agent that spends its
   whole budget on the wrong things stays inside the limit. Detecting that is a separate
   judgement (see "Not implemented").

### Checked immediately before every signature

A standard Solana RPC cannot return an account as it was at an earlier slot. So the gate reads
the Allowance right before it signs, and writes what it read into the ledger (`allowance_checked`
event: slot, allowance address, raw account data in base64, decoded fields). Nothing is cached
from startup or from an earlier step.

| # | Check | Otherwise | Where |
|---|---|---|---|
| 1 | a `task_id` is given (always required for Solana payments) | `BLOCK TASK_MISSING` | [`lib/tasks.ts#L164`](lib/tasks.ts#L164) |
| 2 | the task is active (not closed) | `BLOCK TASK_NOT_ACTIVE` | same |
| 3 | before the task's deadline | `BLOCK TASK_EXPIRED` | same |
| 4 | the Allowance exists, is delegated to the gate key, has not expired on chain; the RPC answered | `BLOCK ALLOWANCE_REVOKED` / `_DELEGATE_MISMATCH` / `_EXPIRED` / `_UNAVAILABLE` (fail closed) | [`lib/tasks.ts#L184`](lib/tasks.ts#L184) |
| 5 | the remaining amount covers this payment | `BLOCK ALLOWANCE_INSUFFICIENT` | same |
| 6 | then the existing Intercepta screening, fixed rules and action policy | as before | [`lib/gate.ts#L174`](lib/gate.ts#L174) |

Checks 1–5 run when a payment is evaluated, and again at signing time
([`lib/gate.ts#L409`](lib/gate.ts#L409)). The re-check matters when a
payment waited for the owner's approval: meanwhile the task may have been closed or the budget
used by other payments. Each paid payment therefore has two `allowance_checked` entries,
`evaluate` and `signing`, each with its own slot. The tests assert this, and removing the
signing-time check makes them fail.

**Pull, then pay.** A Fixed delegation can only be spent through the program's `transferFixed`,
signed by the delegatee. A standard x402 Solana payment is a plain token transfer signed by the
payer. So for each approved payment the gate first pulls exactly that amount under the Allowance
into its own token account ([`lib/gate.ts#L414`](lib/gate.ts#L414)), then pays
the seller with a normal x402 `exact` payment signed by the same gate key, through the PayAI
facilitator. The on-chain Allowance still limits the total. If the seller does not settle after a
pull, the funds stay in the gate's account (the timeline flags that spend and on-chain use differ).

Chain calls live in [`lib/solana/allowance.ts`](lib/solana/allowance.ts): create
[L92](lib/solana/allowance.ts#L92), read
[L117](lib/solana/allowance.ts#L117), revoke
[L125](lib/solana/allowance.ts#L125), pull
[L133](lib/solana/allowance.ts#L133). All writes go through the SDK's plugin client
(`client.subscriptions.instructions.*`, built in [L55](lib/solana/allowance.ts#L55)), which
reads the SubscriptionAuthority's init id for create and resolves transfer-hook accounts for pull.

**Owner key on the server (devnet trade-off).** Creating and revoking an Allowance must be
signed by the delegator (the owner). In this build the owner key sits on the server
(`OWNER_SOLANA_PRIVATE_KEY`), and only the owner-authenticated task API can use it; the gate API
never does. A production version should have the owner sign in their own wallet.

**Agent and seller are different addresses.** `AGENT_SOLANA_ADDRESS` is used in one place: task
issuance refuses to delegate the Allowance to it ([`lib/tasks.ts#L92`](lib/tasks.ts#L92)).
`SELLER_SOLANA_PAY_TO` is the payee the allowlist admits. Setting both to one address would pass
every check, but we keep them separate:
- the demo agent holds no Solana key (it only calls the gate API), so its address states which
  key must never become the delegate. Making it the seller says "the agent is the payee", and the
  ledger would then show the owner's budget paid to the agent, which is exactly the self-dealing
  the gate is there to stop;
- if the agent later gets a real wallet, an allowlisted seller that is the agent's wallet becomes
  a way to move the budget to the agent through ordinary allowlisted purchases;
- a separate address costs nothing: the agent's needs no SOL or USDC.

`npm run task -- preflight` warns (does not block) when the two are equal.

### Actions, not only payments

Money rules cannot see a disclosed address or a promised discount: those cost 0 and pass any
budget. So the agent also asks before other kinds of action
([`lib/gate.ts#L680`](lib/gate.ts#L680)). Policies are in
[`config/actions.json`](config/actions.json):

| Action | What it covers | Default policy |
|---|---|---|
| `pay` | paying; measurable in money; the budget bounds the damage | `allow` (all money rules and the task budget still apply) |
| `commit` | agreements and promises: a price cut, a confirmed date, meeting in person | `ask_human` |
| `disclose` | an address, a phone number, credentials | `ask_human` |
| `impersonate` | speaking as the owner | `deny` |

The four policies are:
- `allow`: proceeds automatically.
- `ask_human`: the owner approves with World ID. The proof's signal is bound to the action type
  and the payload's SHA-256.
- `deny`: never allowed. No approval request is created, so no human approval can override it.
- `notify`: allowed, and flagged for the owner to review afterwards.

`POST /api/gate/evaluate { task_id, action_type, payload }` only judges and records a
non-payment action. The agent performs the action itself; Interlock never posts or sends
anything on the agent's behalf. The ledger stores the payload's hash, its field names and the
agent's one-line description. The payload values themselves (an address, the text) are never
stored.

**Limitation of declared actions.** With `/api/gate/evaluate` the action type is declared by
the agent. An agent that does not realise it is disclosing an address (the Muse incident) will not
ask. That is why messages now go through the gate instead.

### Messages: the gate sends, and reads the text itself

`POST /api/act/send { task_id, channel, to, body, declared_type? }` (agent token;
[`lib/gate.ts#L770`](lib/gate.ts#L770)). The gate holds the channel; the agent has no other way
to deliver. The demo channel is a venue inbox ([`/inbox`](app/inbox/page.tsx)) that shows what the
recipient actually received. This is phase 1 of
[`docs/PROPOSAL-action-executor.md`](docs/PROPOSAL-action-executor.md).

The gate decides the type from the text, deterministically ([`lib/protect.ts`](lib/protect.ts)):
- **The owner's registered data** (`npm run task -- protect add address home`): stored only in
  `data/protected.json` on the server, never in the ledger, never sent to the agent. The text is
  normalised first (full-width → half-width, dash variants, kanji numerals, `1丁目2番3号` / `1-2-3`).
  An address hits on the whole address, on its postal code, on its street number, or on the
  first part of the street number next to the neighbourhood name. Phone numbers are compared as
  national numbers (`+81 90…` = `090…`); email addresses case-insensitively, also with `(at)`.
- **Patterns for unregistered data**: Japanese phone numbers, email addresses, card numbers
  (Luhn-valid).
- Any hit → `disclose`. The strictest policy of every type found, plus the type the agent
  declared, decides; a declaration can only make it stricter. Nothing found → sent automatically.
- **Approval is bound to the message.** The World ID signal binds `sha256(channel, recipient,
  text)`. On approval the gate sends exactly the held text, after checking the hash again; any
  other text, including the same text sent again later, is a new decision.
- The ledger records hashes, the body length, and which entry and which parts matched
  (`owner.home: postal_code, street_number`), never the text, the recipient or a matched value.

Not covered (phase 2+): meaning (a promise, speaking as the owner, a paraphrased address), text
split across messages or encoded, images. Any channel the agent can reach without the gate
bypasses it, the same way a funded key of its own would bypass the budget.

### Intercepta on Solana

Intercepta's documented chains are EVM. The Scan Message `chainId` enum includes Base (8453) but
no Solana chain, and the address/token scans are documented for EVM addresses. **A Solana address
itself cannot be screened.** A Solana payment is screened, as before, through its Base mainnet
stand-ins (`screening.targets` in `config/policy.json`, and devnet USDC → Base USDC in
`config/screening.json`).

What runs on a Solana payment:

| Check | On Solana | Why |
|---|---|---|
| Quick / Deep Scan Address | runs, on the seller's Base mainnet stand-in | same as Base |
| Scan Token | runs, on Base USDC | same as Base |
| Scan Message | **not run**; recorded as `SCAN_MESSAGE_NOT_APPLICABLE_SOLANA` in the decision's reasons and in `screening_result.skipped` | it screens an EIP-712 message before signing. On Solana the gate signs a Solana transaction (an SPL token transfer), so there is no EIP-712 message. Sending an EIP-3009 message instead (as the first Solana build did) screened something that is never signed. |

The two checks that run still decide as before: RISKY or UNAVAILABLE (including HTTP 429) BLOCKs.

When screening BLOCKs, the agent's output, the server log (`[screening] …` lines) and
`npm run why` all name the check, its HTTP status and its reason; `npm run why` also prints the
start of the raw Intercepta response from the ledger.

### Ledger additions

New event types:
- `task_opened`: purpose, budget, deadline, Allowance address, create tx, read-back snapshot
- `task_closed`: revoke tx and the snapshot after revoking
- `action_judged`: a non-payment action's decision
- `allowance_checked`: every chain read, with its slot and raw data

Existing payment events now carry `task_id`. All of these are in the same hash chain.

### Status (Colosseum build)

| Part | Status |
|---|---|
| Tasks, owner-only issuance, delegate checks, the five checks at evaluate and at signing, action policies, ledger | **Verified offline**: `test/tasks.integration.test.ts` (22 tests) runs against an in-memory chain. Its account bytes are produced by the SDK's own encoder, so the real decoder runs. |
| Allowance create / read / revoke on devnet | **Live on devnet (2026-09-30)**, `npm run test:devnet` on the owner's Mac: create tx [2gaReUQd…](https://explorer.solana.com/tx/2gaReUQdRso7ovKH66hNSuUFLzqdzKprRzg3iPzc2d2WmcPJcTi3fPReh3FYK7LMe4ZEFaxS4CMFZmGVFJEyCjaN?cluster=devnet), read back at slot 506042095 (delegator = owner, delegatee = gate key, 10000 atomic), revoke tx [3SWUSX1o…](https://explorer.solana.com/tx/3SWUSX1ouX9pcpJfcwmgoyXfGW5KVR1h3myT54JA4wYATZthZ3bRB1WaVSPrT4JidhKjchUSHnRoBTHypS8wFLCo?cluster=devnet), then the account read as closed. The owner's SubscriptionAuthority was set up with `init-authority` the same day. |
| Scenario 1 on devnet: task, pull (`transferFixed`), x402 Solana payment through PayAI, budget stop | **Live on devnet (2026-10-01)** on the owner's Mac. Task `task_c3691d19fc5bc08467a3db28`, Allowance [HvBKR2s8…](https://explorer.solana.com/address/HvBKR2s8xrKh26AMNpDswCTAcrndmzqektWLqY4LP5JH?cluster=devnet) for 1.00 USDC delegated to the gate key. Purchases 1–3 (0.30 each) paid: [hwV1op5x…](https://explorer.solana.com/tx/hwV1op5xkFtYJ5Fu6nQVq4KAfAKkDL29oxio26c3STd7MHW9uqHUxMhV6WyFCDRrUV81TWzKcsQuCNQ3Jtc17NQ?cluster=devnet), [4mL59wt5…](https://explorer.solana.com/tx/4mL59wt5JmPBu8Nvtz6VzksfNT82qBckj4eEP8ni1WaQcNFJ8HpciM8cApHiaeobtGsHiTDdHRYNHQUSnJHKEnN5?cluster=devnet), [5BUdAQ5j…](https://explorer.solana.com/tx/5BUdAQ5jBU5pqmEmnNFHvbDBd6BFDLKeXTEHsGVpy1g8RGttpQCBAFjpy1MHP6SDVX7Jw13AqqupYewKLYFDZgyX?cluster=devnet). Purchase 4: `BLOCK ALLOWANCE_INSUFFICIENT`. `task show` read 0.9 used / 0.1 remaining at slot 506513123. Screening: `quick_scan_address` SAFE, `scan_token` SAFE, `scan_message` SKIPPED (`SCAN_MESSAGE_NOT_APPLICABLE_SOLANA`). |
| Scenario 2 (declared actions) on devnet task | **Live (2026-10-02)** on the owner's Mac: `disclose` → ASK_HUMAN → rejected in the browser → `HUMAN_REJECTED`; `commit` → ASK_HUMAN → 180 s → `HUMAN_EXPIRED`; `impersonate` → `DENY ACTION_DENIED` with no approval URL. |
| Scenario 3 (close, then pay) on devnet | **Live (2026-10-02)**: close revoked the Allowance, tx [2W3jCSWi…](https://explorer.solana.com/tx/2W3jCSWiE3VmskK368EYXcbW1mH1aHPdkZNUXbEYAxFwdaYHDLjFTazhwjF14iS7MXP7A7YgD3KGzqJVBckceY5t?cluster=devnet); the next payment `BLOCK TASK_NOT_ACTIVE` (before screening); `task show` status closed, remaining 0 at slot 506551607. |
| Messages sent through the gate (`POST /api/act/send`, deterministic content check, venue inbox) | **Live (2026-10-02)** on the owner's Mac, task `task_9642ffbb67a4ad381c70d001` (Allowance [9D19eupH…](https://explorer.solana.com/address/9D19eupH2EynYe7tZwu45n8SAeasAp9FmbgjzXMe3Pue?cluster=devnet)). The owner's demo address was registered with `protect add` (`protect list` shows it masked). "Saturday 18:00 works for us." → `ALLOW CONTENT_NONE_DETECTED -> SENT` (message 05135ff4…). "Great, the owner will meet you at 神宮前1丁目2番3号 on Saturday.", **no type declared by the agent** → `ASK_HUMAN CONTENT_PROTECTED_MATCH`, found `owner.home (street_number, locality)` → rejected in the browser → `HUMAN_REJECTED`, not sent. |
| `@x402/svm` 2.27.0 with `@solana/kit` 7 | `npm ci` warns that `@x402/svm`'s bundled token libraries declare `@solana/kit` ^5 as a peer. **Works at runtime**: the scenario 1 payments above went through it. |

### Not implemented

- Writing ledger hashes to Solana. The Allowance already puts budget and delegation history on chain.
- A delegation format or delegation state of Interlock's own.
- Count or rate limits. They cannot tell a runaway from a busy but healthy agent.
- Executing non-payment actions on the agent's behalf, other than messages on the demo channel.
- Production deployment.
- **Future:** a separate "is this still the task?" judgement (for example Jev's `task_fit`) to
  catch a runaway agent. The budget only caps the loss.


## Agent Procurement Policy Engine: Spend Guard (shadow) and Delivery Review (record)

Brief: [`spec/07-agent-procurement-policy-engine.md`](spec/07-agent-procurement-policy-engine.md),
implementing the concept published on 2026-09-20. Staying within budget and spending well are
different things. Everything above enforces the first in code (on-chain remaining budget, payee
screening, limits, signing, task state, deterministic matching). Spend Guard adds a judgement of
meaning: is this purchase needed for the task, and does it repeat one already made?

**Stage reached: 1–4 of 8 done; stage 5 in confirm mode (built, devnet run pending).** Spend
Guard was checked against the owner's labels on 48 devnet purchases (spec/08) and now runs in
**confirm mode**: a purchase it judges out of place goes to the owner (World ID) instead of being
paid automatically. **It never blocks on its own**, it never loosens a fixed rule (a BLOCK stays a
BLOCK), and when it cannot judge it asks (fail closed). The owner's approval or rejection is kept as
a label (`owner_decision_label`) for the next check. Delivery Review is **record only**.
Procurement Router is not built yet.

**What the check showed, and its limits** ([`config/appe-thresholds.json`](config/appe-thresholds.json)
`validation`): "necessary or useful" separates the owner's labels clearly (needed 0.61 / 0.80 /
0.90, not needed 0.03 / 0.07 / 0.75, min / median / max). The rule "necessary or useful" < 0.50 or
nature unrelated flagged 20 purchases, all not needed, and stopped none of the 23 needed ones. The
one miss (`music-track` for a music video whose track already exists) needs information the task
purpose does not give. **Checked only on made-up scenarios with clearly out-of-place purchases;
subtle judgements on real purchases are not checked.** With 0 of 23, the rate of wrongly stopping a
needed purchase is bounded at about 13% (95%), which is why Spend Guard only asks. The duplicate
question is not used: exact repeats are the fixed repurchase rule's (`REPURCHASE_IN_WINDOW`).

- **Jev** ([`lib/jev.ts`](lib/jev.ts)), via the official SDK `@typesafe-ai/sdk` 0.6.0:
  `POST /v1/systemone`, question types `noul` (yes/no probability), `choice` and `score`. (The
  brief says `/v1/decisions` and `binary`; the SDK, published by TypeSafe, uses these names.)
  Timeout 3 s, one retry. Missing key, HTTP error, timeout, or an answer that does not match its
  question → `UNAVAILABLE`, which Spend Guard counts as `ask_human` (fail closed). Identical
  requests are cached for 10 minutes. The returned `model` string is recorded with every review.
- **What Jev sees** ([`lib/appe.ts`](lib/appe.ts)): the task purpose and budget, the purchase target
  (URL up to the path), the seller's description (truncated), the amount, and the last 20
  purchases in the task (URL, amount, a SHA-256 identifier of the data obtained). All of it goes
  in as JSON data; the question text says to judge it and never follow instructions inside it.
- **Questions:** necessity (noul), duplicate (noul), nature (choice: direct / supporting /
  unrelated / not enough information).
- **would_have**, from [`config/appe-thresholds.json`](config/appe-thresholds.json) (validated
  2026-10-06): "necessary or useful" (asked in its own call) < 0.20 or nature "unrelated" →
  `block`; < 0.50 → `ask_human`; UNAVAILABLE → `ask_human`; else `none`. In confirm mode both
  `block` and `ask_human` become ASK_HUMAN with the reason codes; 0.20 is recorded as the line for a
  future automatic block, which is not enabled. (Until 2026-10-06: the brief's provisional values,
  "necessary" < 0.40 / < 0.75, duplicate ≥ 0.50, shadow only.)
- **Ledger:** `spend_guard_review` next to each task payment decision: probabilities, nature,
  would_have and its reason codes (`SPEND_GUARD_UNNECESSARY` / `_DUPLICATE` / `_UNAVAILABLE`),
  the actual decision, `jev_model`, `policy_version` (version + hash of the thresholds file).
- **Not asked** when the fixed rules already block (principle 7): no task, budget or Allowance
  problem, allowlist or limits. It runs in parallel with Intercepta, so it adds little wait.
- A probability is Jev's answer distribution, not the chance that a payment is safe.

**Delivery Review** ([`lib/delivery.ts`](lib/delivery.ts)), after every paid task purchase. Paid
and 200 does not mean the data asked for arrived. A purchase can state what it needs
(`payload.requirements`: period, required fields, minimum items).
- **Code checks** (`fields_ok`): HTTP status, JSON, item count, required fields on every item, the
  period in the response against the requested one.
- **Jev** (the first 32 KB of the body, as data): does it answer the request (noul), what it is in
  substance (choice: real data / empty / dummy or fixed values / error text / undeterminable),
  how fully it meets the request (score 0–9: the API allows at most 10 levels; the brief asked for 0–10).
- **Ledger** `delivery_review`: tx, URL, amount, the body's SHA-256 and size (never the body),
  latency, the code checks, Jev's answers, `jev_model`, `policy_version`.
- Record only: it never refunds or reverses a payment, and one review is not a score for the seller.
  Whether the content is true is a different question it does not answer.
- Demo sellers on devnet, 0.05 USDC each: `sol-stats` (answers the period asked),
  `sol-stats-stale` (says "latest and complete", returns last year with a fixed value and no
  `listeners`), `sol-stats-empty` (no rows).

**Stage 4, the check before any enforcement** (spec/07 section 4). 34 purchases across 6 tasks
([`config/appe-eval-scenarios.json`](config/appe-eval-scenarios.json), demo catalog
[`config/eval-catalog.json`](config/eval-catalog.json), 0.02–0.04 USDC each) run in shadow mode
(`npm run appe-eval-run`). The owner labels each one needed / not needed / not sure with one key
(`npm run appe-label`; Jev's answer is shown only after the label; stop and resume any time;
labels are `owner_label` ledger events). `npm run appe-metrics` then reports the four metrics
separately, the probability ranges per label, and candidate rules for **both wordings of the
necessity question** ("necessary" and "necessary or useful", asked in separate calls on the same
purchases). It decides nothing; the owner chooses and records the reason in
`config/appe-thresholds.json`. A set of labels the owner withdraws is closed off with
`npm run appe-label -- --reset --reason "..."` (an `owner_label_reset` event; earlier labels stay in
the ledger but no longer count). The first labelling pass (2026-10-05) was keyed at random and has
been withdrawn this way. The second pass (boundary only, 22 labels) showed no separation; why, and
what to check next, is in [`spec/08`](spec/08-stage4-review-and-validation-order.md): the boundary
left out the off-topic purchases where Jev had separated clearly, repeats were labelled "not
needed" and scored with the necessity question, and 22 labels cannot show a moderate signal.
**Stage 4 is not decided; stage 5 stays blocked.**

**Boundary-only labelling** (2026-10-05). `npm run appe-label -- --boundary` asks only about
purchases whose "necessary or useful" probability is between 0.30 and 0.85 for any judge; the
others are skipped, are **not** labelled automatically, and are left out of
`npm run appe-metrics -- --boundary`, which prints 「境界のみで n 件」 and how many were left out
above and below. Boundary numbers say nothing about purchases a judge was sure about, nor about
thresholds outside the range, so in that mode only "necessary or useful" rules with thresholds
inside it are listed. The brief's minimum of 30 labelled purchases still applies to the boundary
set.

**Judge model is a setting** (2026-10-05). `config/appe-thresholds.json` `jev.provider` picks
`typesafe` (Jev, `POST https://api.typesafe.ai/v1/systemone`, `jev-1.13.0`) or `clef` (a server the
owner runs with the same `/v1/systemone` contract; `CLEF_BASE_URL`, `CLEF_API_KEY` only if it asks
for one). The provider is recorded with every review (`jev_provider`), and the model pin works the
same way for both. A provider with no key setting gets a placeholder key, so the TypeSafe key is
never sent to another server. To compare on the same purchases without buying again:
`npm run appe-compare -- --provider typesafe` and `-- --provider clef` rebuild each review's state
from the ledger (the state hash matches the live one for reviews recorded from now on; older ones
are marked "rebuilt"), ask both wordings, and append `spend_guard_replay` events (probabilities,
model, state hash; not the state). `npm run appe-metrics -- --source clef` scores one judge;
with replays present it also lists every judge's ranges on the same purchases. The decision
between them is made on the owner's labels, not on benchmarks. **Clef has not been run here**:
no Clef server was available, so only a local stand-in with the same contract was used.

**Double payment on retry, seen live (2026-10-05), fixed.** During the stage 4 run, two payment
requests hung for over 5 minutes (the Allowance pull waiting for a WebSocket confirmation) and the
run script retried them. Both first requests later completed, so `weather-tokyo` (venue task) and
`crypto-news` (eth task) were each paid twice (0.02 USDC each; task usage 0.16 and 0.10 instead
of 0.14 and 0.08). The repurchase rule only saw completed payments. Now (spec/07 section 8, the
same-purchase part): a payment is reserved in the ledger (`payment_reserved`) before any money
moves, with no await between the check and the reservation. A second purchase of the same resource
in the same task is refused while the first is running (`PURCHASE_IN_FLIGHT`), or at the
reservation if the first completed after the second's decision began (`PURCHASED_SINCE_DECISION`).
A payment whose outcome is unknown (pull unconfirmed, or no answer from the seller after signing)
stays reserved (`PREVIOUS_PAYMENT_UNCONFIRMED`) until the owner checks the chain and runs
`npm run task -- release <decision_id> --reason "..."`. Also: every Solana send is bounded (60 s)
and the run script never retries a payment. Not covered: several server processes sharing one
ledger file, and reconciling a pull that did land without the seller being paid (the amount stays
in the gate's account).

`npm run jev-probe` makes one live call with a synthetic state and checks the response shape
(`npm run jev-probe -- --provider clef` for a Clef server: it prints the model string it returns).
`npm run why` and the agent's output show the shadow result per payment.

| Spend Guard part | Status |
|---|---|
| Jev layer, Spend Guard shadow, ledger | **Verified offline**: `test/jev.test.ts` (fake API following the SDK contract), Spend Guard tests in `test/tasks.integration.test.ts`. |
| A live call to Jev | **Live (2026-10-03)**, `npm run jev-probe` on the owner's Mac: HTTP 200 in 403 ms, all three answer shapes (`noul`, `choice`, `score`) as the SDK documents, model returned `jev-1.13.0`, now pinned in `config/appe-thresholds.json` (request and expected model). Spend Guard on devnet: **not yet run.** |
| Spend Guard shadow on devnet | **Live (2026-10-04)**, `npm run spend-guard-run` on the owner's Mac, jev-1.13.0, 244–272 ms per call. Music-video task, stock clip twice: necessity 0.22 / 0.26, nature `direct` (0.63 / 0.75), duplicate 0.08 → **0.89** on the repeat. Tax-filing task, the same clip: necessity 0.02, nature `unrelated` (1.0). All three paid; all three would_have `block`, because necessity sits below the provisional 0.40 even for a direct purchase (see below). |
| Delivery Review on devnet | **Live (2026-10-04)**, `npm run delivery-review-run` on the owner's Mac, jev-1.13.0, three 0.05 USDC purchases, all paid. `sol-stats`: fields_ok true, answers 0.94, substance real_data (0.93), fulfillment 8.95/9. `sol-stats-stale` ("latest and complete"): fields_ok false (period mismatch, no `listeners`), answers 0.02, substance dummy_or_fixed (1.0), fulfillment 2.52/9. `sol-stats-empty`: fields_ok false (0 items), answers 0.05, substance empty (0.99), fulfillment 1.05/9. No body in the ledger. The first run got HTTP 400/422 from the API (more than 10 score levels; undescribed levels), fixed by a 0–9 rubric. |

**What the first live numbers say (n = 3, not a validation).** nature and duplicate separate the
cases clearly (direct vs unrelated 1.0; duplicate 0.08 vs 0.89). The necessity question does not
fit the provisional thresholds: a stock clip for a music video gets 0.22–0.26, so 0.40 / 0.75 would
block it, while the unrelated purchase gets 0.02. "Necessary" seems to be read strictly ("could be
done without it"). Neither the thresholds nor the question are changed yet: that is what the
section 4 check (≥ 30 purchases judged by the owner) is for. Candidates to compare there: a lower
necessity threshold, or nature as the primary signal, or a question that asks "needed or useful".

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
| Testnet payTo → mainnet screening address | [`lib/policy.ts#L117`](lib/policy.ts#L117) |
| Screening on Base mainnet + aggregation | [`lib/screening.ts#L111`](lib/screening.ts#L111) |
| Called from the gate, before any signing | [`lib/gate.ts#L198`](lib/gate.ts#L198) |

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
| Four exits: approve / reject / expire / cancel | [`lib/gate.ts#L574`](lib/gate.ts#L574), [L609](lib/gate.ts#L609), [L556](lib/gate.ts#L556), [L615](lib/gate.ts#L615) |
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
npm ci
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
