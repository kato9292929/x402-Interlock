// Live devnet check of the Allowance adapter: create -> read -> revoke -> read.
// Skipped unless SOLANA_DEVNET_TEST=1 and the keys are set (it spends devnet SOL for rent/fees).
// `npm run test:devnet` sets the flag and reads the keys from .env.local (docs/DEMO-colosseum.md).
// The owner needs devnet SOL and a devnet USDC token account, and must have run
// `npm run task -- init-authority` once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SolanaAllowanceChain } from "../lib/solana/allowance";

const enabled = process.env.SOLANA_DEVNET_TEST === "1" && !!process.env.OWNER_SOLANA_PRIVATE_KEY && !!process.env.GATE_SOLANA_PRIVATE_KEY;

test("devnet: create, read, revoke an Allowance delegated to the gate key", { skip: !enabled && "needs SOLANA_DEVNET_TEST=1, OWNER_SOLANA_PRIVATE_KEY and GATE_SOLANA_PRIVATE_KEY (npm run test:devnet)" }, async () => {
  const chain = new SolanaAllowanceChain();
  const gate = await chain.gateAddress();
  const owner = await chain.ownerAddress();
  const expiryTs = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const created = await chain.create({ delegatee: gate, amount: 10_000n, expiryTs, nonce: BigInt(Date.now()) });
  console.log("created", created);
  const snap = await chain.read(created.address);
  console.log("read", { slot: snap.slot, decoded: snap.decoded });
  assert.equal(snap.exists, true);
  assert.equal(snap.decoded?.delegatee, gate);
  assert.equal(snap.decoded?.delegator, owner);
  assert.equal(snap.decoded?.amount, "10000");
  const revoked = await chain.revoke(created.address);
  console.log("revoked", revoked);
  assert.equal((await chain.read(created.address)).exists, false);
});
