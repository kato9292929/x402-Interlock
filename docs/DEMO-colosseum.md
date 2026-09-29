# Demo: per-task budgets and the action gate (Colosseum)

Solana devnet. Run on the owner's machine: World ID steps need World App on a phone.

## One-time setup

1. Fill the Solana block in `.env.local` (see `.env.example`):
   `OWNER_TOKEN`, `GATE_SOLANA_PRIVATE_KEY`, `OWNER_SOLANA_PRIVATE_KEY`, `AGENT_SOLANA_ADDRESS`, `SELLER_SOLANA_PAY_TO`.
2. Fund the accounts on devnet:
   - owner and gate: devnet SOL, for fees and rent
   - owner: devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), for example from Circle's faucet
3. Enable the owner's SubscriptionAuthority for USDC (once): `npm run task -- init-authority`
4. `npm run dev`, then open http://localhost:3000/tasks

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
