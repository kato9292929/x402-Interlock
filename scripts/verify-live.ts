// Live checks against the real services. Prints raw results and appends each one to
// data/live-checks.jsonl with a timestamp, so first-success times in FEEDBACK.md come
// from a record, not memory. Nothing here is mocked.
//
//   npm run verify-live            # all checks
//   npm run verify-live -- intercepta | world | facilitator | wallet

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deepScanAddress, quickScanAddress, scanMessage, scanToken, type CheckResult } from "../lib/intercepta";
import { loadPolicy, type MainnetAddress } from "../lib/policy";
import { loadScreeningConfig, rulesFrom, transferAuthorizationTypedData } from "../lib/screening";
import { verifyAuthHeaders, WORLD_ENV } from "../lib/world";

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
  // Same inputs the gate uses: the mainnet stand-ins from config/policy.json, Base (8453).
  const cfg = loadScreeningConfig();
  const policy = loadPolicy();
  const rules = rulesFrom(cfg);
  const t = 15_000;
  const chainId = cfg.screening_chain_id;
  const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`).address;
  const asset = cfg.asset_to_mainnet[USDC_SEPOLIA.toLowerCase()] as MainnetAddress;
  const targets = policy.screening?.targets ?? [];
  if (!targets.length) console.log("!! no screening targets resolved: set SELLER_PAY_TO / SELLER_MAINNET_ADDRESS (and RISKY_*)");

  const checks: CheckResult[] = [];
  for (const target of targets) {
    const addr = target.mainnet as MainnetAddress;
    checks.push(await quickScanAddress(addr, rules.address, t));
    checks.push(await deepScanAddress(addr, rules.address, t));
  }
  checks.push(await scanToken(asset, String(chainId), rules.token, t));
  for (const target of targets) {
    const typed = transferAuthorizationTypedData({
      from: buyer,
      to: target.mainnet as MainnetAddress,
      value: "10000",
      chainId,
      verifyingContract: asset,
      extra: { name: "USD Coin", version: "2" },
    });
    checks.push(await scanMessage(buyer, typed, String(chainId), process.env.PUBLIC_BASE_URL ?? "http://localhost:3000", rules.message, t));
  }
  for (const c of checks) {
    // Logged as-is. "answered" = HTTP 2xx; the gate's verdict is shown separately and not changed here.
    record(`intercepta.${c.check} ${c.target}`, !!c.http_status && c.http_status >= 200 && c.http_status < 300, {
      http_status: c.http_status ?? null,
      gate_verdict: c.verdict,
      gate_reasons: c.reasons,
      error: c.error ?? null,
      body: c.response ?? null,
    });
  }
}

/**
 * Probe POST /api/v4/verify/{rp_id} with a deliberately invalid sandbox proof. It can never
 * verify; the point is World's status and error body: 400 = request accepted and the proof
 * rejected, 401/403 = the call itself needs credentials (the body may say which header).
 */
async function world() {
  const env = WORLD_ENV();
  const rp = process.env.WORLD_RP_ID;
  if (!rp) return record("world.verify_probe", false, { error: "WORLD_RP_ID is not set" });
  const bogus = { protocol_version: "4.0", nonce: "0x01", action: "interlock-probe", environment: env, responses: [] };
  const attempts: [string, Record<string, string>][] = [["without api key", {}]];
  try {
    const auth = verifyAuthHeaders(env);
    if (Object.keys(auth).length) attempts.push([`with ${process.env.WORLD_API_KEY_HEADER}`, auth]);
  } catch (e) {
    return record("world.verify_probe", false, { error: (e as Error).message });
  }
  for (const [label, headers] of attempts) {
    try {
      const res = await fetch(`https://developer.world.org/api/v4/verify/${rp}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(bogus),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let fromWorld = true;
      try {
        JSON.parse(text);
      } catch {
        fromWorld = false; // e.g. a proxy's plain-text 403: says nothing about World's auth
      }
      const denied = res.status === 401 || res.status === 403;
      record(`world.verify_probe ${env} ${label}`, fromWorld && !denied, {
        http_status: res.status,
        auth_required: !fromWorld ? "inconclusive (response is not World's JSON)" : denied,
        www_authenticate: res.headers.get("www-authenticate"),
        body: text,
      });
    } catch (e) {
      record(`world.verify_probe ${env} ${label}`, false, { error: (e as Error).message });
    }
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
const all = { intercepta, world, facilitator, wallet } as const;
(async () => {
  for (const [name, fn] of Object.entries(all)) if (!which || which === name) await fn();
})();
