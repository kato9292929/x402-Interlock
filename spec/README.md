# spec/

Specs and prompts given to AI coding tools while building **x402 Interlock**.

> Naming: the brief (`00-instructions.md`) uses the working title "Countersign". The owner renamed the service to **x402 Interlock** on 2026-09-26 (~02:30 JST). The brief is kept verbatim.

| File | What it is |
|---|---|
| `00-instructions.md` | The owner's implementation brief, handed verbatim to Claude Code (cloud session) at 2026-09-26 01:44 JST |
| `01-ai-log.md` | Log of what the AI generated, per commit/file, and what was verified |
| `02-research-prompt.md` | Prompt given to a research sub-agent for the partner APIs |
| `03-live-api-alignment.md` | Second brief (09-26 ~15:15 JST): align with official Intercepta docs, split mainnet screening config, live verification |
| `04-intercepta-official-spec.md` | Official Intercepta reference (pasted by the owner) and the screening thresholds derived from it |
| `05-world-id-sandbox-api-key.md` | Brief on the World ID sandbox verification API key |
| `06-tasks-and-action-gate.md` | Brief for the Colosseum submission: per-task budgets on Solana Allowances and the action gate |

Moved out (2026-10-08): `09-provenance-rules.md` and `10-external-trust-inventory.md`, with
`research/probe-catalog.mjs`, `research/payto-summary.mjs`, `research/probe-402.mjs`,
`research/check-402.sh`, `research/provenance-pairs.mjs` and `data/payto-observations.jsonl`,
went to [kato9292929/data402](https://github.com/kato9292929/data402) with their history
(`spec/00-provenance.md` there maps the commit hashes). Observing x402 listings is a separate
product from this gate. The commits that added them stay in this repository's history.
