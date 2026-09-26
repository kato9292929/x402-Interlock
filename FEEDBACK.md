# Feedback

> Times come from the local records (`npm run first-success` reads `data/live-checks.jsonl` and `data/ledger.jsonl`).
> Items marked (build) come from the AI-assisted build session. At that point the vendor docs were unreachable from the build container.

## Intercepta

- Time to first successful call: **2026-09-26 19:01:16 JST** (first 2xx from `npm run verify-live`, recorded in `data/live-checks.jsonl`). The first screening inside the gate followed at 19:14:08 JST: `risky` was BLOCKed with SCREENING_RISKY.
- Confusing:
  - Scan Message takes the EIP-712 payload as-is, so x402's EIP-3009 `TransferWithAuthorization` fits. It came back as `messageType=TransferWithAuthorization`, `riskGroup=Low`. But the docs list neither the values `riskGroup` can take nor how they map to the risk library's tiers, so a gate can only classify values it has already seen.
- Missing:
  - The free hackathon key's rate limit is easy to hit during a demo. A payment gate makes about three calls per payment (address, token, message), so a few payments in a row got `HTTP 429 "API Key rate limit is reached"` on Scan Token. That made a safe payment fail closed. The limit and its window are not stated with the key or in the error, and there is no `Retry-After` hint. We now cache token scans for 10 minutes to stay under it.
  - (build) Testnet chain IDs: the Scan Message `chainId` enum has Base (8453) but not Base Sepolia (84532), so a testnet payment has to be rebuilt with mainnet values before it can be screened.

## World (World ID for Agents)

- Time to first successful verification: **2026-09-26 19:49:44 JST**, 14 minutes after the first approval request at 19:35:21 JST (`data/ledger.jsonl`). Most of those 14 minutes went into two findings: sandbox was refused (`environment_not_allowed`), and the user-presence face check failed.
- Stumbling points:
  - (build) There are three "agent" products (human-in-the-loop, IDKit requests, AgentKit), and at first it was hard to tell which one fits "approve this one payment".
  - (build) `@worldcoin/human-in-the-loop` is tied to the Vercel Workflow SDK. A framework-free server was easier to build directly on IDKit 4 (`signRequest` + verify API).
  - Verifying with `environment: "sandbox"` was refused with `environment_not_allowed`. Switching to `production` worked. The sandbox guide still says sandbox proofs go to the same verify endpoint with nothing else required.
  - With `require_user_presence: true`, the face check in World App failed and the approval never completed. Without it, everything worked. The error gave no hint whether the device, the credential or the request was at fault.
  - v4 RPs can only be registered in a production app, which was not obvious from the portal flow.
- Missing features/docs:
  - (build) We heard that sandbox/staging verification now requires the team API key (after the `environment` fix), but the published docs we found still say the opposite. The OpenAPI spec for `POST /api/v4/verify/{rp_id}` has no `security`, and the sandbox guide says "Nothing else is required". The key's header name is not documented anywhere we could find.
  - (build) The idkit-core README still points to `developer.worldcoin.org/api/v4/verify`, while the docs use `developer.world.org`.
  - (build) A documented pattern for binding a proof to a specific transaction (signal = hash of payment params) and for pinning an owner's nullifier across many approvals.
- One improvement that would help most: a single, current page for the v4 server-side flow that states which `environment` values the verify endpoint accepts for which app type, and what credentials each needs. Sandbox, staging and production behaved differently from what the docs describe, and that cost the most time.
