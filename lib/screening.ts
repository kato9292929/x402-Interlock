import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toAtomic } from "./amount";
import { deepScanAddress, quickScanAddress, scanMessage, scanToken, type CheckResult } from "./intercepta";
import type { PaymentOption, Screening } from "./policy";

interface ScreeningConfig {
  network_to_mainnet_chain_id: Record<string, number>;
  asset_to_mainnet: Record<string, string>;
  address_block_if_toxic_score_at_least: number;
  address_block_if_any_trait: boolean;
  deep_scan_above: string;
  timeout_ms: number;
}

export function loadScreeningConfig(file = path.join(process.cwd(), "config", "screening.json")): ScreeningConfig {
  return JSON.parse(readFileSync(file, "utf8")) as ScreeningConfig;
}

export interface ScreeningReport extends Screening {
  checks: CheckResult[];
}

/** EIP-3009 TransferWithAuthorization, the message x402 "exact" asks the buyer to sign. */
export function transferAuthorizationTypedData(
  from: string,
  option: PaymentOption & { extra?: Record<string, unknown>; maxTimeoutSeconds?: number },
  chainId: number,
  verifyingContract: string,
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    domain: {
      name: String(option.extra?.name ?? "USD Coin"),
      version: String(option.extra?.version ?? "2"),
      chainId,
      verifyingContract,
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
      from,
      to: option.payTo,
      value: option.amount,
      validAfter: String(now - 600),
      validBefore: String(now + (option.maxTimeoutSeconds ?? 300)),
      nonce: "0x" + randomBytes(32).toString("hex"),
    },
  };
}

/**
 * Screen the option that would actually be paid: payTo, token and the
 * authorization message. Intercepta data is mainnet-only, so testnet
 * networks/assets are mapped to their mainnet counterparts first.
 */
export async function screen(
  option: PaymentOption & { extra?: Record<string, unknown>; maxTimeoutSeconds?: number },
  buyer: string,
  website: string,
  tokenDecimals: number,
  cfg = loadScreeningConfig(),
): Promise<ScreeningReport> {
  const rule = { blockAtScore: cfg.address_block_if_toxic_score_at_least, blockOnAnyTrait: cfg.address_block_if_any_trait };
  const t = cfg.timeout_ms;
  const chainId = cfg.network_to_mainnet_chain_id[option.network];
  const mainnetAsset = cfg.asset_to_mainnet[option.asset.toLowerCase()];
  if (!chainId || !mainnetAsset) {
    return {
      verdict: "UNAVAILABLE",
      reasons: [`no mainnet mapping for ${option.network} / ${option.asset}`],
      checks: [],
    };
  }

  const deep = BigInt(option.amount) > toAtomic(cfg.deep_scan_above, tokenDecimals);
  const typed = transferAuthorizationTypedData(buyer, option, chainId, mainnetAsset);
  const checks = await Promise.all([
    deep ? deepScanAddress(option.payTo, rule, t) : quickScanAddress(option.payTo, rule, t),
    scanToken(mainnetAsset, chainId, t),
    scanMessage(buyer, typed, chainId, website, t),
  ]);

  const risky = checks.filter((c) => c.verdict === "RISKY");
  const unavailable = checks.filter((c) => c.verdict === "UNAVAILABLE");
  const verdict = risky.length ? "RISKY" : unavailable.length ? "UNAVAILABLE" : "SAFE";
  const reasons = [...risky, ...unavailable].flatMap((c) => c.reasons.map((r) => `${c.check}: ${r}`));
  return { verdict, reasons, checks };
}
