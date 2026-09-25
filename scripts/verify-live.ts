// Live checks against the real services. Prints raw results and appends each one to
// data/live-checks.jsonl with a timestamp, so first-success times in FEEDBACK.md come
// from a record, not memory. Nothing here is mocked.
//
//   npm run verify-live            # all checks
//   npm run verify-live -- intercepta | facilitator | wallet

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deepScanAddress, quickScanAddress, scanMessage, scanToken, type CheckResult } from "../lib/intercepta";
import { loadScreeningConfig, transferAuthorizationTypedData } from "../lib/screening";

const LOG = path.join(process.cwd(), "data", "live-checks.jsonl");
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function record(name: string, ok: boolean, detail: unknown) {
  mkdirSync(path.dirname(LOG), { recursive: true });
  const line = { at: new Date().toISOString(), check: name, ok, detail };
  appendFileSync(LOG, JSON.stringify(line) + "\n");
  console.log(`\n=== ${name}: ${ok ? "OK" : "FAILED"} (${line.at})`);
  console.log(JSON.stringify(detail, null, 2));
}

async function intercepta() {
  const cfg = loadScreeningConfig();
  const rule = { blockAtScore: cfg.address_block_if_toxic_score_at_least, blockOnAnyTrait: cfg.address_block_if_any_trait };
  const t = 15_000;
  const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`).address;
  const targets = [process.env.SELLER_PAY_TO, process.env.RISKY_PAY_TO].filter(Boolean) as string[];
  const baseUsdc = cfg.asset_to_mainnet[USDC_SEPOLIA.toLowerCase()];
  const checks: CheckResult[] = [];
  for (const a of targets) {
    checks.push(await quickScanAddress(a, rule, t));
    checks.push(await deepScanAddress(a, rule, t));
  }
  checks.push(await scanToken(baseUsdc, 8453, t));
  const typed = transferAuthorizationTypedData(
    buyer,
    { scheme: "exact", network: "eip155:84532", asset: USDC_SEPOLIA, payTo: targets[0], amount: "10000", extra: { name: "USDC", version: "2" } },
    8453,
    baseUsdc,
  );
  checks.push(await scanMessage(buyer, typed, 8453, process.env.PUBLIC_BASE_URL ?? "http://localhost:3000", t));
  for (const c of checks) {
    // "ok" = the API answered 2xx with a body the gate understands (SAFE or RISKY), not that it is safe.
    record(`intercepta.${c.check} ${c.target}`, c.verdict !== "UNAVAILABLE", c);
  }
}

async function facilitator() {
  const url = "https://x402.org/facilitator/supported";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    const kinds = (body?.kinds ?? []) as { network?: string; scheme?: string }[];
    const ok = res.ok && kinds.some((k) => k.network === "eip155:84532" && k.scheme === "exact");
    record("facilitator.supported eip155:84532 exact", ok, { status: res.status, kinds });
  } catch (e) {
    record("facilitator.supported", false, { error: (e as Error).message });
  }
}

async function wallet() {
  try {
    const acct = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
    const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
    const bal = await client.readContract({ address: USDC_SEPOLIA, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
    record("wallet.usdc_balance", bal > 0n, { address: acct.address, usdc_atomic: bal.toString() });
  } catch (e) {
    record("wallet.usdc_balance", false, { error: (e as Error).message });
  }
}

const which = process.argv[2];
const all = { intercepta, facilitator, wallet } as const;
(async () => {
  for (const [name, fn] of Object.entries(all)) if (!which || which === name) await fn();
})();
