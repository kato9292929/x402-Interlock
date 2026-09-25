# Research prompt (Claude Code sub-agent)

Used at ~02:00 JST 09-26 because intercepta.io and docs.world.org were blocked from the build
container. The sub-agent returned notes only; it wrote no code into the repo.

> Research, using WebFetch/WebSearch (docs.world.org and intercepta.io are blocked; github.com,
> raw.githubusercontent.com, the npm registry via `npm view`, and unpkg/jsdelivr may work), the
> following and report concrete technical details (URLs, request/response JSON shapes, header
> names, npm package names and exported function signatures). Do NOT write any code files.
>
> 1. "World ID for Agents": how a server requests a human approval for an agent action, how the
>    human approves (World App), how the server verifies the result server-side, which credentials
>    exist and how to pick one, how nullifier/action/signal work, and whether reject/cancel/expire
>    states exist. Also the IDKit 4 request flow (rp signature, rp_id, app_id, signing key).
> 2. Intercepta API: base URL, auth header, endpoints for Quick Scan Address, Deep Scan Address,
>    Scan Token, Scan Message, request/response shapes.
> 3. x402 v2 TypeScript packages (@x402/fetch, @x402/express/next, @x402/evm, @x402/core 2.27.0):
>    seller middleware for Base Sepolia, facilitator URL, buyer side: reading payment requirements
>    from a 402, intercepting before signing, creating a payment payload with a viem account,
>    header names.
>
> Mark anything you could not confirm as UNCONFIRMED.
