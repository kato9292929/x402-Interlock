import { readFileSync } from "node:fs";
import path from "node:path";
import { toAtomic } from "./amount";

export type Decision = "PAY" | "CAP" | "ASK_HUMAN" | "BLOCK";

export type ReasonCode =
  | "SCREENING_RISKY"
  | "SCREENING_UNAVAILABLE"
  | "PAYTO_NOT_ALLOWLISTED"
  | "PER_PAYMENT_LIMIT_CAPPED"
  | "PER_PAYMENT_LIMIT_NO_CAP"
  | "RUN_LIMIT_EXCEEDED"
  | "ABOVE_HUMAN_THRESHOLD"
  | "REPURCHASE_IN_WINDOW"
  | "WITHIN_POLICY";

export interface Policy {
  token_decimals: number;
  allowlist: string[];
  max_amount_per_payment: string;
  max_amount_per_run: string;
  ask_human_above: string;
  repurchase_window_minutes: number;
  screening?: { targets: ScreeningTarget[] };
}

// Payments settle on Base Sepolia; Intercepta screens Base mainnet. The two kinds of
// address are distinct types so one cannot be passed where the other is expected.
declare const brand: unique symbol;
export type TestnetAddress = string & { readonly [brand]: "testnet" };
export type MainnetAddress = string & { readonly [brand]: "mainnet" };

export interface ScreeningTarget {
  name: string;
  payTo: string; // testnet payTo (Base Sepolia), what the allowlist holds
  mainnet: string; // Base mainnet address Intercepta screens for that payTo
}

/** One payment option out of an x402 402-response `accepts` list. */
export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string; // atomic units
}

export interface Candidate {
  resource: string; // URL / route being bought
  options: PaymentOption[]; // index 0 is the one the agent wants
}

export interface Screening {
  verdict: "SAFE" | "RISKY" | "UNAVAILABLE";
  reasons: string[];
}

export interface RunContext {
  spentAtomic: bigint; // already paid in this run
  lastPurchaseAt?: Date; // last successful purchase of the same resource
  now: Date;
}

export interface GateResult {
  decision: Decision;
  reasons: ReasonCode[];
  /** The option to pay if the decision is PAY / CAP / ASK_HUMAN. */
  selected?: PaymentOption;
}

/** `env:NAME` -> process.env.NAME (undefined if unset); anything else is returned as-is. */
export function resolveRef(v: string): string | undefined {
  return v.startsWith("env:") ? process.env[v.slice(4)] || undefined : v;
}

export function loadPolicy(file = process.env.POLICY_PATH ?? path.join(process.cwd(), "config", "policy.json")): Policy {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Policy;
  const targets = (raw.screening?.targets ?? []).flatMap((t) => {
    const payTo = resolveRef(t.payTo);
    const mainnet = resolveRef(t.mainnet);
    return payTo && mainnet ? [{ name: t.name, payTo, mainnet }] : [];
  });
  return {
    ...raw,
    // Unset env entries drop out, so a missing address can only make the gate stricter.
    allowlist: raw.allowlist.map(resolveRef).filter((a): a is string => !!a),
    screening: { targets },
  };
}

/** The mainnet address to screen for a testnet payTo, or undefined (-> cannot screen -> BLOCK). */
export function mainnetScreeningAddress(policy: Policy, payTo: TestnetAddress): MainnetAddress | undefined {
  const t = policy.screening?.targets.find((x) => x.payTo.toLowerCase() === payTo.toLowerCase());
  return t ? (t.mainnet as MainnetAddress) : undefined;
}

const lower = (s: string) => s.toLowerCase();

/**
 * Aggregation order (spec §3.4):
 *  1. screening risky/unavailable -> BLOCK
 *  2. payTo not allowlisted       -> BLOCK
 *  3. over per-payment limit      -> CAP to a cheaper offered option, else BLOCK
 *  4. over run limit              -> BLOCK
 *  5. over ask_human_above / repurchase in window -> ASK_HUMAN
 *  6. otherwise                   -> PAY
 *
 * x402 "exact" payments cannot be partially paid, so CAP means choosing a
 * cheaper option the seller itself offered in `accepts`.
 */
export function evaluatePolicy(
  policy: Policy,
  candidate: Candidate,
  screening: Screening,
  ctx: RunContext,
): GateResult {
  const d = policy.token_decimals;
  const perPayment = toAtomic(policy.max_amount_per_payment, d);
  const perRun = toAtomic(policy.max_amount_per_run, d);
  const askAbove = toAtomic(policy.ask_human_above, d);
  const allow = new Set(policy.allowlist.map(lower));
  const block = (reasons: ReasonCode[]): GateResult => ({ decision: "BLOCK", reasons });

  if (screening.verdict === "RISKY") return block(["SCREENING_RISKY"]);
  if (screening.verdict !== "SAFE") return block(["SCREENING_UNAVAILABLE"]);

  const wanted = candidate.options[0];
  if (!wanted) return block(["PER_PAYMENT_LIMIT_NO_CAP"]);
  if (!allow.has(lower(wanted.payTo))) return block(["PAYTO_NOT_ALLOWLISTED"]);

  const reasons: ReasonCode[] = [];
  let selected = wanted;
  let capped = false;
  if (BigInt(wanted.amount) > perPayment) {
    const cheaper = candidate.options
      .filter((o) => allow.has(lower(o.payTo)) && BigInt(o.amount) <= perPayment)
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))[0];
    if (!cheaper) return block(["PER_PAYMENT_LIMIT_NO_CAP"]);
    selected = cheaper;
    capped = true;
    reasons.push("PER_PAYMENT_LIMIT_CAPPED");
  }

  const amount = BigInt(selected.amount);
  if (ctx.spentAtomic + amount > perRun) return block([...reasons, "RUN_LIMIT_EXCEEDED"]);

  if (amount > askAbove) reasons.push("ABOVE_HUMAN_THRESHOLD");
  const windowMs = policy.repurchase_window_minutes * 60_000;
  if (ctx.lastPurchaseAt && ctx.now.getTime() - ctx.lastPurchaseAt.getTime() < windowMs) {
    reasons.push("REPURCHASE_IN_WINDOW");
  }
  if (reasons.includes("ABOVE_HUMAN_THRESHOLD") || reasons.includes("REPURCHASE_IN_WINDOW")) {
    return { decision: "ASK_HUMAN", reasons, selected };
  }
  if (capped) return { decision: "CAP", reasons, selected };
  return { decision: "PAY", reasons: ["WITHIN_POLICY"], selected };
}
