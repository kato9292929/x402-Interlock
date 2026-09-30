# Demo: per-task budgets and the action gate (Colosseum)

Solana devnet. Run on the owner's machine: World ID steps need World App on a phone.

## One-time setup

### 1. Keys and `.env.local`

Fill the Solana block in `.env.local` (see `.env.example`):
- `OWNER_TOKEN`, `GATE_SOLANA_PRIVATE_KEY`, `OWNER_SOLANA_PRIVATE_KEY`
- `AGENT_SOLANA_ADDRESS`, `SELLER_SOLANA_PAY_TO`

The two private keys must be different keypairs, and the agent's address must differ from both.

### 2. What each account needs on devnet

| Account | Needs | Why | How |
|---|---|---|---|
| owner | devnet SOL (≈0.05 is plenty) | fees; rent for the SubscriptionAuthority and each task's Allowance | `solana airdrop 1 <OWNER_ADDRESS> --url devnet`, or https://faucet.solana.com |
| owner | a **USDC token account** for mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | the Allowance delegates from this account | created automatically when USDC is sent to the owner (below) |
| owner | devnet USDC (≥ the task budget) | the budget itself | https://faucet.circle.com → Solana Devnet → the owner address |
| gate | devnet SOL | fees for each pull and rent for its own USDC token account (created on the first pull) | `solana airdrop 1 <GATE_ADDRESS> --url devnet` |
| seller | a USDC token account | to receive payments | send it any devnet USDC once, or `spl-token create-account` for it |

If the owner has SOL but no USDC token account yet (for example, the faucet has not been used),
create it explicitly:

```bash
spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
  --owner <OWNER_ADDRESS> --fee-payer <owner-keypair.json> --url devnet
```

### 3. Check, then enable the owner's SubscriptionAuthority (once)

```bash
npm run task -- preflight        # read-only: SOL balances, owner USDC account and balance, authority
npm run task -- init-authority   # one transaction, signed by the owner
```

`preflight` lists each problem in plain words (no SOL, no USDC token account, 0 USDC) and the
address it expects. `init-authority` runs the same checks first and refuses with that list if
something is missing. It does nothing if the authority already exists.

If a transaction still fails, the CLI prints the error's causes, the decoded program error when
the Subscriptions program failed, a hint, and the full simulation logs. Paste that output when
reporting.

### 4. Run

`npm run dev`, then open http://localhost:3000/tasks

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
