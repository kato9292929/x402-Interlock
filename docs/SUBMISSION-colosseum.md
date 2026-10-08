# Colosseum Crypto World's Fair: submission draft

Draft for the submission form and the two videos. Bracketed parts are for the team to fill in.
Check the form itself for field names, limits and the deadline (2026-10-12 according to search
results; hour and time zone not confirmed). Nothing here claims users or demand that do not exist.

## Form fields

**Name:** x402 Interlock

**One line:** An AI agent never gets a key: for each task it gets a Solana Allowance with a budget
and an expiry, delegated to a gate, and when something looks wrong the gate asks the owner, who
approves with World ID.

**The problem.** People are starting to let agents pay and talk for them: book a venue, buy data,
order a render. Today that usually means handing the agent a funded key or a card. A spending limit
the agent holds the key to is not a limit, and no spending limit sees an action that costs nothing:
while we built this, a booking agent wrote the owner's home address into a message to a venue.

**What we built.**
- A task is the unit of budget, and a task is one Solana Allowance (the Subscriptions & Allowances
  program, Fixed delegation): the owner is the delegator, the gate's key is the delegatee, the
  amount is the budget and the expiry is the deadline. The agent holds no key.
- Every payment and message goes through the gate. Before each payment it reads the Allowance from
  chain (open, not expired, enough left), screens the payee (Intercepta), applies fixed limits, and
  refuses a second purchase of the same thing while the first is still running or unconfirmed. It
  then pulls exactly that amount under the Allowance and pays the seller with x402.
- Outgoing messages are sent by the gate, which checks the text against the owner's registered data
  (address, phone, email; Japanese address forms normalised). A match is held for the owner.
- The owner approves with World ID; the approval is bound to the hash of the exact payment or text.
- Closing a task revokes the Allowance on chain. Every step is in an append-only, hash-chained ledger.

**How Solana is used.** Budgets and their expiry live on chain as Fixed delegations
(`@solana/subscriptions`: create, `transferFixed`, revoke); Interlock has no budget state of its
own and reads the remaining amount from chain before every payment. Payments are x402 on Solana
(`@x402/svm`, PayAI facilitator). `@solana/kit` 7.

**What runs today (Solana devnet, on one machine).** Three scenes, with transactions linked in the
README: a fourth payment stopped by the Allowance's remaining balance; a message with the owner's
address held and never delivered; a closed task's next payment stopped. Also live: payee screening
on Solana, declared actions (deny / ask), World ID approval and rejection. Covered by tests only:
the double-payment guard, unconfirmed transfers. Full list: README "Status in three lists".

**How we decided whether to use an AI judge.** We built a judge-model check ("is this purchase
needed for the task?", TypeSafe Jev) and measured it against rules with no model, on our own data:
48 devnet purchases across 6 made-up tasks, labelled by the owner.

| Method | Not-needed caught | Needed flagged |
|---|---|---|
| Keywords: purpose vs item name + description | 13 / 22 (59%) | 0 |
| Keywords: purpose vs item name only | 20 / 22 (91%) | 11 |
| Judge model | 20 / 21 (95%) | 0 |

Clearly unrelated purchases are caught by keywords alone. The model added 8 catches, all
subjective (out of scope, more than asked, free elsewhere). We wrote the scenarios, wrote the
keyword rule after seeing the items, and have not measured how often real agents buy things they
do not need. So the judge is off and kept as a removable part; the gate's core is deterministic.

**Demand and validation.** None yet. Nobody uses it and nobody has said they would pay for it.
What we will measure next, in this order: (1) how often agents that pay through x402 actually make
the failures the gate stops (wrong or repeated purchases, leaked personal data), from real purchase
logs; (2) whether teams building such agents would route payments and messages through a gate they
do not hold the key to.

**Go-to-market / distribution.** [Team to write. A plan only, nothing done yet: e.g. open-source
gate for teams building x402 agents on Solana; first conversations with N teams; what would make
them adopt it.]

**Competition.** Circle, Coinbase and Privy offer wallets and spending policies for agents. What
this adds: a per-task Allowance delegated to a gate (the agent never holds a key), checking what an
agent says as well as what it spends, and owner approval bound to the exact content.

**Blockchains and tools:** Solana devnet; Solana Subscriptions & Allowances (`@solana/subscriptions`
0.5.0); `@solana/kit` 7; x402 (`@x402/svm`, PayAI facilitator); Intercepta (address and token
screening); World ID (owner approval); Next.js 16. (Earlier build: ETHGlobal Tokyo 2026 on Base
Sepolia.)

**Team:** [names, backgrounds, previous work] · **Location:** [city, country] · **Logo:** [file]

**GitHub:** https://github.com/kato9292929/x402-Interlock · **Pitch video:** [link] ·
**Technical demo:** [link]

## Technical demo (≤ 3:00): three scenes

Commands and what to point at are in [`docs/DEMO-colosseum.md`](DEMO-colosseum.md) ("Technical
demo"). Every result on screen must be a real run; cut waiting, do not speed up or fake.

| Time | Scene |
|---|---|
| 0:00–0:20 | What it is: the agent holds no key; every payment and message goes through the gate. README diagram. |
| 0:20–1:20 | **Budget.** Open a task (1.00 USDC): the Allowance on Explorer, delegatee = the gate's key. Three payments of 0.30 go through; the fourth: `BLOCK ALLOWANCE_INSUFFICIENT`. /tasks shows 0.90 used, read from chain at a slot. |
| 1:20–2:15 | **A message with the owner's address.** A plain message is sent. Then "the owner will meet you at 神宮前1丁目2番3号", nothing declared: `CONTENT_PROTECTED_MATCH`, the approval page shows what matched, reject, the venue's inbox stays empty. |
| 2:15–2:45 | **Close the task.** Revoke tx on Explorer; the next payment: `BLOCK TASK_NOT_ACTIVE`, before anything else. |
| 2:45–3:00 | How we decided on the AI judge (the table above, one sentence), and the repo URL. |

## Pitch video (≤ 2:00)

| Time | Content |
|---|---|
| 0:00–0:20 | The problem as a story: a booking agent wrote the owner's home address to a venue. It cost nothing, so no spending limit saw it. |
| 0:20–0:45 | Why budgets alone are not enough: a limit the agent holds the key to is not a limit, and money limits cannot read what an agent says. |
| 0:45–1:15 | x402 Interlock: per-task Allowances on Solana delegated to a gate; the gate pays, sends and asks. 15 s of the demo: the message held, the inbox empty. |
| 1:15–1:35 | How we decide what goes in: we measured an AI judge against keywords on our own data and turned it off. |
| 1:35–1:50 | Where we are, plainly: devnet, no users, no one paying yet; what we will measure next. |
| 1:50–2:00 | Team, one line. |
