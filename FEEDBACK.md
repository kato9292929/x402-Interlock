# Feedback

> The owner fills in the times and first-hand impressions after the first live calls.
> Items marked (build) come from the AI-assisted build session. At that point the vendor docs were unreachable from the build container.

## Intercepta

- Time to first successful call: _TODO (owner: record the time of the first 2xx response)_
- Confusing:
  - (build) There is no single typed schema for response bodies. Quick Scan returns `toxicScore` and `traits`, while token and message scans use `action`, `riskLevel` and `detectors`. We had to write a separate parser for each.
  - (build) Scan Message takes the EIP-712 payload as-is, so x402's EIP-3009 `TransferWithAuthorization` fits. But the meaning of each `riskGroup` value has to be looked up in the risk library before a gate can act on it.
- Missing:
  - (build) Testnet chain IDs: the Scan Message `chainId` enum has Base (8453) but not Base Sepolia (84532), so a testnet payment has to be rebuilt with mainnet values before it can be screened.
  - _TODO_

## World (World ID for Agents)

- Time to first successful verification: _TODO_
- Stumbling points:
  - (build) There are three "agent" products (human-in-the-loop, IDKit requests, AgentKit), and at first it was hard to tell which one fits "approve this one payment".
  - (build) `@worldcoin/human-in-the-loop` is tied to the Vercel Workflow SDK. A framework-free server was easier to build directly on IDKit 4 (`signRequest` + verify API).
  - _TODO_
- Missing features/docs:
  - (build) A documented pattern for binding a proof to a specific transaction (signal = hash of payment params) and for pinning an owner's nullifier across many approvals.
- One improvement that would help most: _TODO_
