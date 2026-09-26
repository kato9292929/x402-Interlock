import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toAtomic } from "./amount";
import { deepScanAddress, quickScanAddress, scanMessage, scanToken, type CheckResult } from "./intercepta";
import type { MainnetAddress, PaymentOption, Screening } from "./policy";

// Payments settle on Base Sepolia, but Intercepta's risk data is Base mainnet only,
// so every check runs against the mainnet counterpart (chainId 8453) of what is paid.

interface ScreeningConfig {
  screening_chain_id: number;
  asset_to_mainnet: Record<string, string>;
  address: { block_traits: string[]; ask_human_traits: string[] };
  token: { block_actions: string[]; ask_human_actions: string[]; pass_actions: string[] };
  message: { block_risk_groups: string[]; pass_risk_groups: string[] };
  deep_scan_above: string;
  timeout_ms: number;
  /** How long an answered token scan is reused (per chainId + token). 0 disables. Default 10. */
  token_cache_minutes?: number;
}

export type { ScreeningConfig };

export function rulesFrom(cfg: ScreeningConfig) {
  return {
    address: { blockTraits: cfg.address.block_traits, askHumanTraits: cfg.address.ask_human_traits },
    token: { blockActions: cfg.token.block_actions, askHumanActions: cfg.token.ask_human_actions, passActions: cfg.token.pass_actions },
    message: { blockRiskGroups: cfg.message.block_risk_groups, passRiskGroups: cfg.message.pass_risk_groups },
  };
}

export function loadScreeningConfig(file = process.env.SCREENING_PATH ?? path.join(process.cwd(), "config", "screening.json")): ScreeningConfig {
  return JSON.parse(readFileSync(file, "utf8")) as ScreeningConfig;
}

export interface ScreeningReport extends Screening {
  checks: CheckResult[];
  /** The mainnet addresses actually screened, recorded next to the testnet payment. */
  screened_as?: { chain_id: number; payTo: MainnetAddress; asset: MainnetAddress };
}

/**
 * EIP-3009 TransferWithAuthorization, the message x402 "exact" asks the buyer to sign,
 * rebuilt with mainnet values (chain, token contract, recipient) for screening.
 */
export function transferAuthorizationTypedData(p: {
  from: string;
  to: MainnetAddress;
  value: string;
  chainId: number;
  verifyingContract: MainnetAddress;
  extra?: Record<string, unknown>;
  maxTimeoutSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    domain: {
      name: String(p.extra?.name ?? "USD Coin"),
      version: String(p.extra?.version ?? "2"),
      chainId: p.chainId,
      verifyingContract: p.verifyingContract,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: p.from,
      to: p.to,
      value: p.value,
      validAfter: String(now - 600),
      validBefore: String(now + (p.maxTimeoutSeconds ?? 300)),
      nonce: "0x" + randomBytes(32).toString("hex"),
    },
  };
}

const unavailable = (reason: string): ScreeningReport => ({ verdict: "UNAVAILABLE", reasons: [reason], checks: [] });

/**
 * Screen the option that would actually be paid: payTo, token and the authorization
 * message, each as its Base mainnet counterpart. `payToMainnet` comes from
 * config/policy.json screening.targets; without it the payment cannot be screened.
 */
export async function screen(
  option: PaymentOption & { extra?: Record<string, unknown>; maxTimeoutSeconds?: number },
  payToMainnet: MainnetAddress | undefined,
  buyer: string,
  website: string,
  tokenDecimals: number,
  cfg = loadScreeningConfig(),
): Promise<ScreeningReport> {
  const rules = rulesFrom(cfg);
  const t = cfg.timeout_ms;
  const chainId = cfg.screening_chain_id;
  const asset = cfg.asset_to_mainnet[option.asset.toLowerCase()] as MainnetAddress | undefined;
  if (!payToMainnet) return unavailable(`no mainnet screening address configured for payTo ${option.payTo}`);
  if (!asset) return unavailable(`no mainnet counterpart configured for asset ${option.asset}`);

  const deep = BigInt(option.amount) > toAtomic(cfg.deep_scan_above, tokenDecimals);
  const typed = transferAuthorizationTypedData({
    from: buyer,
    to: payToMainnet,
    value: option.amount,
    chainId,
    verifyingContract: asset,
    extra: option.extra,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
  });
  const checks = await Promise.all([
    deep ? deepScanAddress(payToMainnet, rules.address, t) : quickScanAddress(payToMainnet, rules.address, t),
    scanToken(asset, String(chainId), rules.token, t, (cfg.token_cache_minutes ?? 10) * 60_000),
    scanMessage(buyer, typed, String(chainId), website, rules.message, t),
  ]);

  // Worst verdict wins: RISKY > UNAVAILABLE > CAUTION > SAFE.
  const risky = checks.filter((c) => c.verdict === "RISKY");
  const down = checks.filter((c) => c.verdict === "UNAVAILABLE");
  const caution = checks.filter((c) => c.verdict === "CAUTION");
  const verdict = risky.length ? "RISKY" : down.length ? "UNAVAILABLE" : caution.length ? "CAUTION" : "SAFE";
  const reasons = [...risky, ...down, ...caution].flatMap((c) => c.reasons.map((r) => `${c.check}: ${r}`));
  return { verdict, reasons, checks, screened_as: { chain_id: chainId, payTo: payToMainnet, asset } };
}
