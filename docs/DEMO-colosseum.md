# Demo: per-task budgets and the action gate (Colosseum)

Solana devnet. Run on the owner's machine: World ID steps need World App on a phone.

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
| `OWNER_TOKEN` | any secret; must differ from `AGENT_TOKEN`. The task CLI sends it. |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `SOLANA_RPC_WS_URL` | optional. Unset: `SOLANA_RPC_URL` with `http` → `ws`, which works for the public devnet RPC. Set it only for an RPC provider with a separate WebSocket URL. |
| `OWNER_SOLANA_PRIVATE_KEY` | owner keypair, base58 64-byte secret key (Phantom export format) |
| `GATE_SOLANA_PRIVATE_KEY` | gate keypair, same format, a different keypair from the owner |
| `AGENT_SOLANA_ADDRESS` | the agent's public key (must differ from owner and gate) |
| `SELLER_SOLANA_PAY_TO` | the demo seller's public key |

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
| seller | a USDC token account | to receive payments | send it any devnet USDC once, or `spl-token create-account` for it |

If the owner has SOL but no USDC token account yet, create it explicitly:

```bash
spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <OWNER_ADDRESS> --fee-payer <owner-keypair.json> --url devnet
```

## Devnet run, in order

No server is needed for steps 1–3; they talk to devnet directly.

```bash
npm run task -- preflight
npm run task -- init-authority
npm run test:devnet
```

1. `preflight` (read-only) lists each problem in plain words (no SOL, no USDC token account,
   0 USDC) with the address it expects. Expected: no problems, `subscription_authority.exists: true`.
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
- purchases 1–3 (0.30 USDC each): `PAY WITHIN_POLICY -> PAID`, each with a devnet tx link
- purchase 4: `BLOCK ALLOWANCE_INSUFFICIENT` (0.10 USDC left)
- `/tasks`: 0.90 spent, 0.10 remaining on chain (with the slot)
- each payment's ledger events include two `allowance_checked` entries (evaluate, signing)

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
