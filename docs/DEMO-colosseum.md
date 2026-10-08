# Demo: per-task budgets and the action gate (Colosseum)

Solana devnet. Run on the owner's machine: World ID steps need World App on a phone.

Recording the videos and filling in the submission: see [Submission and recording](#submission-and-recording) at the end.

## Get the latest code

Run these one line at a time. `.env.local` and `data/` are ignored by git; nothing below touches them.

```bash
git status --short
git checkout -- package.json package-lock.json
git pull
npm ci
```

- `git checkout -- …` drops changes that npm wrote to those two files. They hold no work of yours:
  the repo already records the dependencies and the install-script decisions (`allowScripts`).
- If `git pull` still stops with "Your local changes … would be overwritten", `git status --short`
  names the files. Keep them aside with `git stash`, then run `git pull` again. `git stash list`
  still has them.
- Use `npm ci`, not `npm install`. `npm ci` installs exactly what `package-lock.json` says and never
  writes `package.json` or `package-lock.json`, so the next `git pull` cannot be blocked by it.
- Do not run `npm install-scripts approve`. `esbuild` and `fsevents` are recorded as not running
  install scripts, which is npm 11's default; nothing here needs them.
- If `npm run dev` was running, stop it (Ctrl+C) and start it again so the server uses the new code.

## Environment variables (`.env.local`)

Solana block (see `.env.example`):

| Variable | Value |
|---|---|
| `OWNER_TOKEN` | the owner's API token; must differ from `AGENT_TOKEN`. The task CLI sends it. Made by `new-token` below. |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `SOLANA_RPC_WS_URL` | optional. Unset: `SOLANA_RPC_URL` with `http` → `ws`, which works for the public devnet RPC. Set it only for an RPC provider with a separate WebSocket URL. |
| `OWNER_SOLANA_PRIVATE_KEY` | owner keypair, base58 64-byte secret key (Phantom export format) |
| `GATE_SOLANA_PRIVATE_KEY` | gate keypair, same format, a different keypair from the owner |
| `AGENT_SOLANA_ADDRESS` | the agent's public key; must differ from owner and gate, and should differ from the seller. Made by `new-address` below. |
| `SELLER_SOLANA_PAY_TO` | the demo seller's public key. Made by `new-address` below. |

To add one line without it joining the previous line, append with a leading newline:

```bash
printf '\n%s\n' 'SOLANA_RPC_URL=https://api.devnet.solana.com' >> .env.local
```

`npm run task -- preflight` prints the owner and gate addresses derived from the two keys; check
they are the ones you funded.

## What each account needs on devnet

| Account | Needs | Why | How |
|---|---|---|---|
| owner | devnet SOL (≈0.05 is plenty) | fees; rent for the SubscriptionAuthority and each task's Allowance | `solana airdrop 1 <OWNER_ADDRESS> --url devnet`, or https://faucet.solana.com |
| owner | a **USDC token account** for mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | the Allowance delegates from this account | created automatically when USDC is sent to the owner (below) |
| owner | devnet USDC (≥ the task budget) | the budget itself | https://faucet.circle.com → Solana Devnet → the owner address |
| gate | devnet SOL | fees for each pull and rent for its own USDC token account (created on the first pull) | `solana airdrop 1 <GATE_ADDRESS> --url devnet` |
| seller | a USDC token account (no SOL, no USDC) | x402 payments transfer into it | `npm run task -- seller-account` (the owner pays the rent) |
| agent | nothing | its address is only checked, never used on chain | — |

If the owner has SOL but no USDC token account yet, create it explicitly:

```bash
spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <OWNER_ADDRESS> --fee-payer <owner-keypair.json> --url devnet
```

## Owner token, agent and seller addresses

None of these needs editing `.env.local` by hand, a wallet app, the Solana CLI or a faucet.
Run one line at a time:

```bash
npm run task -- new-token OWNER_TOKEN
npm run task -- new-address agent --env AGENT_SOLANA_ADDRESS
npm run task -- new-address seller --env SELLER_SOLANA_PAY_TO
npm run task -- seller-account
```

1. `new-token OWNER_TOKEN` writes a random 43-character token into `.env.local`. It refuses if
   `OWNER_TOKEN` already has a value, or if the new value would equal `AGENT_TOKEN` (the task API
   refuses that). The token is not printed. Expected:
   `{ "name": "OWNER_TOKEN", "env": "OWNER_TOKEN written to .env.local", "length": 43 }`.
   Start (or restart) `npm run dev` after this: the server reads it at startup.
2. `new-address` makes a new keypair, saves it to `keys/<name>.json` (solana-keygen format,
   readable only by you, ignored by git) and writes the public address into `.env.local`. It fills
   an empty `NAME=` line copied from `.env.example`, or adds the line on a line of its own. It
   refuses if the variable already has a value, so it never replaces an address you set.
   Expected: `{ "name": "agent", "address": "…", "keypair_file": "keys/agent.json", "env": "AGENT_SOLANA_ADDRESS written to .env.local" }`.
3. `seller-account` creates the seller's USDC token account (associated token account for the
   devnet USDC mint). The owner signs and pays the rent (≈0.002 SOL); the seller signs nothing.
   Expected: `{ "signature": "…", "seller": "…", "usdc_ata": "…" }` and an Explorer link, or
   `already exists; nothing to do`.

The seller's secret key is kept only so the devnet USDC it receives can be moved later; the
demo never uses it. The agent's is never used.

Why the agent and the seller should not share one address: see "Agent and seller are different
addresses" in the README's Colosseum section. `preflight` warns if they are equal.

## Devnet run, in order

No server is needed for steps 1–3; they talk to devnet directly.

```bash
npm run task -- preflight
npm run task -- init-authority
npm run test:devnet
```

1. `preflight` (read-only) lists each problem in plain words with what to run: no SOL, no USDC
   token account or 0 USDC for the owner, `OWNER_TOKEN` missing or equal to `AGENT_TOKEN`,
   `AGENT_SOLANA_ADDRESS` / `SELLER_SOLANA_PAY_TO` missing or not an address, the seller's USDC
   token account missing. Expected: `all set`, `subscription_authority.exists: true`,
   `seller.usdc_ata_exists: true`, and no `warning(s)` block.
2. `init-authority` sets up the owner's SubscriptionAuthority once. It runs the same checks first,
   and answers `already_initialized: true` if it exists (the case after the first success).
3. `test:devnet` reads the keys from `.env.local` and runs the live Allowance test: create a
   0.01 USDC Allowance delegated to the gate key, read it back from chain, revoke it, read again.
   Expected: `created { address, signature }`, `read { slot, decoded }`, `revoked { signature }`,
   then `pass 1` at the end. It costs only fees; the rent comes back on revoke. If it shows
   `SKIP` (`skipped 1`), the keys were not found in `.env.local`.
4. Then start the server for the scenarios below (they go through the API):

```bash
npm run dev
```

Open http://localhost:3000/tasks.

If a transaction fails, the output has the error's causes, the decoded program error when the
Subscriptions program failed, a hint, and the simulation logs. Paste all of it when reporting.

## 1. Open a task and pay under it

```bash
npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
# prints the task_id, the Allowance address and the create tx (Solana Explorer links)
npm run agent -- sol-clip --task task_... --times 4
```

Expected:
- purchases 1–3 (0.30 USDC each): `PAY WITHIN_POLICY, SCAN_MESSAGE_NOT_APPLICABLE_SOLANA -> PAID`,
  then three `[gate]   screening …` lines (`quick_scan_address: SAFE (HTTP 200)`,
  `scan_token: SAFE (HTTP 200)`, `scan_message: SKIPPED`), and a devnet tx link
- purchase 4: `BLOCK ALLOWANCE_INSUFFICIENT` (0.10 USDC left)
- `/tasks`: 0.90 spent, 0.10 remaining on chain (with the slot)
- each payment's ledger events include two `allowance_checked` entries (evaluate, signing)

`SCAN_MESSAGE_NOT_APPLICABLE_SOLANA` is expected: Scan Message screens EIP-712 messages, and a
Solana payment signs a Solana transaction, so that check is recorded as not run (README,
"Intercepta on Solana").

### When a purchase is blocked

```bash
npm run why
```

It prints the latest decision from the ledger: the decision and its reasons, the Allowance reads,
and each Intercepta check with its HTTP status, reasons, error and the start of the raw response.
`<- RATE LIMITED` marks an HTTP 429 (Intercepta's rate limit; wait and retry). `npm run why --
<decision_id>` shows a specific one. The server terminal prints the same per-check lines as
`[screening] …`.

## 2. Muse: zero money, still stopped

```bash
npm run agent -- act disclose    --task task_... --payload '{"description":"share the owner home address with the venue","address":"(redacted)"}'
npm run agent -- act commit      --task task_... --payload '{"description":"agree to a 30% discount on the fee"}'
npm run agent -- act impersonate --task task_... --payload '{"description":"post on social media as the owner"}'
```

Expected:
- disclose → `ASK_HUMAN`: the approval page says "Allow this action? … no money moves". Reject it.
- commit → `ASK_HUMAN`
- impersonate → `DENY ACTION_DENIED`. There is no approval page; no approval can override it.
- Every amount is zero. A budget alone would have let all three through.

## 3. Close the task

```bash
npm run task -- close task_...
# prints the revoke tx
npm run agent -- sol-clip --task task_...
```

Expected:
- the Allowance account is gone on chain (Explorer: account not found)
- the payment: `BLOCK TASK_NOT_ACTIVE`
- a closed task cannot be reopened; resuming needs a new task

## 4. Muse, for real: the gate reads the message and holds it

The agent no longer declares anything. It asks the gate to send a message; the gate reads the
text, finds the owner's address, and holds it for the owner. The venue inbox shows what the venue
actually received.

Use a demo address for the recording, not your real one: the approval page shows the message.
Registering a real address works the same way; leave the value off the command and the CLI asks for
it, so it does not end up in your shell history.

```bash
npm run task -- protect add address home "〒150-0001 東京都渋谷区神宮前1丁目2番3号"
npm run task -- protect list
npm run task -- open --purpose "Book the venue for the music video" --budget 0.10 --expires 2026-10-13T00:00:00Z
npm run agent -- send --task task_... --to venue@example.com --body "Saturday 18:00 works for us."
npm run agent -- send --task task_... --to venue@example.com --body "Great, the owner will meet you at 神宮前1丁目2番3号 on Saturday."
```

Expected:
- `protect add`: `"registered": "owner.home"`. `protect list` shows the value masked.
- first message: `ALLOW ACTION_ALLOW, CONTENT_NONE_DETECTED -> SENT`; it appears on http://localhost:3000/inbox.
- second message: `ASK_HUMAN ACTION_ASK_HUMAN, CONTENT_PROTECTED_MATCH -> AWAITING_HUMAN`,
  `found disclose: owner.home (protected: street_number, locality)`, and an approval URL.
  The page shows the message, the recipient and what was found. **Reject** → `HUMAN_REJECTED`,
  `not sent`. The inbox still shows only the first message.
- the timeline (/) shows `Not sent: owner rejected`; the ledger has no address, only which parts
  matched.

Other spellings are caught the same way (try any of them as `--body`):
`神宮前１－２－３`, `神宮前一丁目二番三号`, `〒1500001`, `Jingumae 1-2-3`.

Approval is bound to the exact text: approve one with World ID and it is sent as is; send it again,
or with one word changed, and it is a new decision that needs a new approval.

Avoid `!` inside the double-quoted `--body` in zsh (history expansion).

## 5. Spend Guard in shadow mode (spec/07, stages 1–2)

Shadow mode never stops or changes a payment; it records what it would have done.

```bash
npm ci
npm run task -- set-env TYPESAFE_API_KEY
npm run jev-probe
```

- `set-env` asks for the key at a prompt (paste it, Enter), writes it to `.env.local`, does not
  print it, and refuses if the key is already there.
- `jev-probe`: `HTTP 200`, the raw response, `shape OK` for `necessity (noul)`, `nature (choice)`
  and `fit (score)`, and `model returned: jev-…`. Paste the output; that model string gets pinned
  in `config/appe-thresholds.json`.

Restart `npm run dev` (it reads `.env.local` at startup), then:

```bash
npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
npm run agent -- sol-clip --task task_... --times 2
npm run task -- open --purpose "Prepare the quarterly tax filing" --budget 0.30 --expires 2026-10-13T00:00:00Z
npm run agent -- sol-clip --task task_...
npm run why
```

Expected:
- every purchase still pays (`PAID`) as before; each shows one more line,
  `[gate]   spend guard (shadow): would_have …`
- music-video task, purchase 1: necessity high, nature `direct`, would_have `none` (likely)
- music-video task, purchase 2: the same clip endpoint is in `history`; duplicate higher than
  purchase 1, would_have possibly `ask_human (SPEND_GUARD_DUPLICATE)`
- tax-filing task: a stock video clip; necessity low or nature `unrelated` → would_have `block`, and
  **it is still paid**
- `npm run why`: the `spend guard` block with probabilities, model and policy version

These are Jev's answers on real data, so the exact numbers are what we want to see, not a pass or
fail. If Jev is unreachable, every line says `UNAVAILABLE` and would_have `ask_human`, and the
payments still go through.

## 6. Delivery Review (spec/07 stage 3)

Record only: never reverses a payment. With `npm run dev` running in another terminal:

```bash
cd ~/x402-Interlock
npm run delivery-review-run
```

It opens one task (0.30 USDC) and buys the same weekly stats from three demo sellers at 0.05 USDC
each, stating what it needs (period 2026-09-27 to 2026-10-03; date, plays, listeners; ≥ 1 row):

| Seller | Returns | Expected record |
|---|---|---|
| `sol-stats` | the requested period, all fields | `fields_ok true`, substance likely `real_data` |
| `sol-stats-stale` | last year, a fixed value, no `listeners` | `fields_ok false`, period `mismatch`, missing `listeners` |
| `sol-stats-empty` | no rows | `fields_ok false`, substance likely `empty` |

It ends with `checks:` (`yes` / `NO`): all paid, empty seen as empty, period mismatch caught by
code, no purchased body in the ledger, model and policy version recorded. Jev's numbers are what
we want to see, not a pass or fail.

## 7. Stage 4: Spend Guard against the owner's judgement (spec/07 section 4)

Nothing is enforced in this stage. With `npm run dev` running in another terminal:

```bash
cd ~/x402-Interlock
npm run appe-eval-run
npm run appe-label
npm run appe-metrics
```

1. `appe-eval-run` opens 6 tasks and makes 34 purchases (about 1 USDC in total; repeats within a
   task go to the owner by the fixed 10-minute rule and are cancelled, so they cost nothing). Each
   line shows Spend Guard's shadow verdict. `npm run appe-eval-run -- venue` reruns one task.
2. `appe-label`: one purchase per screen line (task purpose, item, price, the seller's
   description in one line). Press `1` needed, `2` not needed, `3` not sure, `q` to stop; run it
   again to continue where you stopped. Jev's numbers appear after your key. When a task's
   purchases are all labelled it asks whether the task's purpose was met (`1` / `2` / `3`).
3. `appe-metrics`: the four metrics, ranges per label, and the rule table for both wordings.
   It says "NOT ENOUGH" until 30 needed + unneeded labels exist.

Label after the run has finished: labels and the server both append to the ledger.

## Submission and recording

### What Colosseum asks for

Checked on 2026-10-02 from web-search summaries of Colosseum's pages; colosseum.com itself could
not be opened from the build environment. **Check the submission form before relying on this.**

| Item | What we found | Still to confirm on the form |
|---|---|---|
| Deadline | 2026-10-12 | hour and time zone |
| Pitch video | the most important item, reviewed first. **2 minutes** is given for Crypto World's Fair; other Colosseum pages say up to 3. Content: team background, the problem, who it is for, validation, vision | hosting (a link: YouTube / Loom / Drive?) |
| Technical demo video | 2–3 minutes: the core features built, the stack, the design decisions, especially how Solana is used (on-chain logic, architecture) | hosting |
| Form fields | product name and short description; blockchains and tools integrated; every teammate with background; location; a logo or graphic; GitHub repository (public encouraged); go-to-market, demand validation, distribution plan | exact field names and limits |

Plan: pitch video **≤ 2:00**, technical demo **≤ 3:00**, so either reading of the rule is met.

Sources: [Colosseum: Perfecting your hackathon submission](https://blog.colosseum.com/perfecting-your-hackathon-submission/),
[Crypto World's Fair](https://colosseum.com/worldsfair), [How to win a Colosseum hackathon](https://blog.colosseum.com/how-to-win-a-colosseum-hackathon/).

### The story, in one line per scenario

One task carries the whole demo. The order follows the argument:

| # | Scenario | The point it makes |
|---|---|---|
| 1 | Task budget and payments | The budget lives on Solana as an Allowance delegated to the gate's key. The agent holds no key. Three payments go through; the fourth stops on the chain's remaining balance. |
| 4 | Muse: the gate reads the message | A budget cannot see a zero-dollar action. The agent sends a message with the owner's address and declares nothing; the gate finds the address in the text and holds it. The owner rejects; the venue never receives it. |
| 3 | Close the task | The owner revokes the Allowance on chain. The next payment stops before anything else is checked. |

(Declared actions, scenario 2, are left out of the video since 2026-10-08.) Scenario 4 comes second on purpose: it is the reason the project exists, and it lands right after
the viewer has seen that budgets work.

### Before recording

- Screen: terminal on the left (font ≥ 18 pt, dark theme, prompt shortened), browser on the right
  at 125 % zoom. Phone with World App nearby (only needed if you show an approval).
- Tabs, open in this order: http://localhost:3000/tasks, http://localhost:3000/inbox,
  http://localhost:3000 (timeline), Solana Explorer (devnet).
- Start from a clean timeline (optional; keeps the screen readable). This keeps
  `data/protected.json` and the World ID owner pinning:

```bash
mv data/ledger.jsonl data/ledger-before-recording.jsonl
mv data/inbox.jsonl data/inbox-before-recording.jsonl
```

- `npm run task -- preflight` → `all set`. Owner has ≥ 1.00 USDC.
- `npm run task -- protect list` → `owner.home` is there (demo address, not your real one).
- `npm run dev` running in a second terminal, off screen.
- Do a full dry run once; then record. Waiting (Solana confirmations, the agent's polling) can be
  cut in editing. Cut, do not speed up or fake: every result on screen must be a real run.

### Technical demo (≤ 3:00): scenes, commands, what to point at

Three scenes (decided 2026-10-08): the budget stops a payment, a message with the owner's address
is held, a closed task stops the next payment. The declared-actions scene (`impersonate` denied)
is left out of the video; it is in the README status table.

Replace `task_…` with the id printed by the first command.

**0:00–0:20 · What it is**
- Show the README diagram (top of the repo) or say it over the terminal:
  "The agent holds no key. Every payment and every message goes through this gate."

**0:20–1:20 · Scene 1: the budget is on Solana**

```bash
npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
```
- Point at `allowance.pubkey`, `delegate` (= the gate key, not the agent), `create_tx`.
- Click the Allowance link → Explorer: the account is owned by the Subscriptions program
  `De1egA…`. Say: "This is a standard Fixed delegation. Interlock has no budget state of its own."

```bash
npm run agent -- sol-clip --task task_… --times 4
```
- Purchases 1–3: point at `[gate] PAY …`, the three `screening` lines (`scan_message: SKIPPED` is
  expected on Solana), and the devnet tx.
- Purchase 4: `BLOCK ALLOWANCE_INSUFFICIENT`. Say: "0.10 left on chain; 0.30 does not fit."
- Switch to /tasks: point at used 0.90 / remaining 0.10 **and the slot**: the number was read from
  chain, not from our database.
- Optional (5 s): one payment tx in Explorer, the `transferFixed` pull under the delegation.

**1:20–2:15 · Scene 2: a message with the owner's address (Muse)**

```bash
npm run agent -- send --task task_… --to venue@example.com --body "Saturday 18:00 works for us."
```
- `ALLOW … CONTENT_NONE_DETECTED -> SENT`. Switch to /inbox: the message is there.

```bash
npm run agent -- send --task task_… --to venue@example.com --body "Great, the owner will meet you at 神宮前1丁目2番3号 on Saturday."
```
- Point at: no type declared in the command; `CONTENT_PROTECTED_MATCH`;
  `found disclose: owner.home (protected: street_number, locality)`.
- Open the approval URL. Point at the message, `found: owner.home`, and `bound to sha256 …`
  ("approval covers this exact text"). Click **Reject**.
- Terminal: `HUMAN_REJECTED`, `not sent`. Switch to /inbox: **still only the first message.**
- Timeline (/): the card says `Not sent: owner rejected`. Expand its ledger events: hashes and
  which parts matched, no address.
- Say: "A zero-dollar action, stopped by what it says, not by how much it costs."

**2:15–2:45 · Scene 3: the owner closes the task**

```bash
npm run task -- close task_…
npm run agent -- sol-clip --task task_…
```
- Point at the `Revoke tx`; Explorer on the Allowance: account not found.
- `BLOCK TASK_NOT_ACTIVE`, before screening. /tasks: closed.

**2:45–3:00 · How we decided on the AI judge, and close**
- The README table "How we decided whether to use an AI judge", one sentence: "keywords catch the
  clearly unrelated ones; the model added 8 subjective catches, so it is off."
- Timeline header: `ledger hash chain intact`. The GitHub repo URL on screen.

### Pitch video (≤ 2:00): outline

Moved to [`docs/SUBMISSION-colosseum.md`](SUBMISSION-colosseum.md) (2026-10-08), with the
decision on the AI judge and the plain statement that there are no users yet.

### Submission text: draft

Moved to [`docs/SUBMISSION-colosseum.md`](SUBMISSION-colosseum.md) (2026-10-08).
