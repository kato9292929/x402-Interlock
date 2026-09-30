import * as subscriptions from "@solana/subscriptions";

const { getSubscriptionsErrorMessage, SUBSCRIPTIONS_PROGRAM_ADDRESS } = subscriptions;

/** code -> SUBSCRIPTIONS_ERROR__* constant name, from the SDK's own exports. */
function subscriptionsErrorName(code: number): string | undefined {
  const hit = Object.entries(subscriptions).find(([k, v]) => k.startsWith("SUBSCRIPTIONS_ERROR__") && v === code);
  return hit?.[0].replace("SUBSCRIPTIONS_ERROR__", "");
}

// Turn a @solana/kit error into something a person can act on. Kit puts the RPC's simulation
// result (including program `logs`) in `error.context`, and the underlying transaction or
// instruction error in `error.cause`. Printing only `error.message` loses all of that.

export interface ExplainedSolanaError {
  message: string;
  /** "Transaction simulation failed" -> its causes, outermost first */
  causes: string[];
  /** program logs from the simulation, if the RPC returned them */
  logs: string[];
  /** a custom program error decoded from its code, when the failing program is known */
  program_error?: string;
  /** one-line guess at what to do, from well-known log lines */
  hint?: string;
}

const safe = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function explainSolanaError(e: unknown): ExplainedSolanaError {
  const out: ExplainedSolanaError = { message: String((e as Error)?.message ?? e), causes: [], logs: [] };
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 8; depth++) {
    const err = cur as { message?: string; context?: Record<string, unknown>; cause?: unknown };
    const ctx = err.context ?? {};
    if (Array.isArray(ctx.logs) && !out.logs.length) out.logs = (ctx.logs as unknown[]).map(String);
    if (depth > 0 && err.message) out.causes.push(err.message);
    if (typeof ctx.code === "number" && typeof ctx.index === "number") {
      out.causes.push(`instruction #${ctx.index} failed with custom error ${ctx.code} (0x${ctx.code.toString(16)})`);
      const failing = failingProgram(out.logs);
      if (failing === SUBSCRIPTIONS_PROGRAM_ADDRESS) {
        let msg: string | undefined;
        try {
          // Only populated in the SDK's development build; production returns undefined.
          msg = getSubscriptionsErrorMessage(ctx.code as never) || undefined;
        } catch {
          msg = undefined;
        }
        const name = subscriptionsErrorName(ctx.code);
        out.program_error = `Subscriptions program: ${name || msg ? [name, msg].filter(Boolean).join(" — ") : `unknown error code ${ctx.code}`}`;
      }
    } else if (depth > 0 && Object.keys(ctx).length && !("logs" in ctx)) {
      out.causes.push(`context: ${safe(ctx)}`);
    }
    cur = err.cause;
  }
  out.hint = hintFromLogs(out.logs, out.causes.join(" "));
  return out;
}

/** The last program that logged "failed" in the simulation. */
function failingProgram(logs: string[]): string | undefined {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /^Program (\w+) failed/.exec(logs[i]);
    if (m) return m[1];
  }
  return undefined;
}

function hintFromLogs(logs: string[], causes: string): string | undefined {
  const all = logs.join("\n") + "\n" + causes;
  if (/insufficient funds for fee|InsufficientFundsForFee|Attempt to debit an account but found no record of a prior credit/i.test(all)) {
    return "The fee payer has no SOL on this cluster. Airdrop devnet SOL to it (https://faucet.solana.com).";
  }
  if (/already in use|AccountAlreadyInitialized|already initialized/i.test(all)) {
    return "The account already exists. For init-authority this means the SubscriptionAuthority is already set up; nothing to do.";
  }
  if (/InvalidAccountData|invalid account data|AccountNotInitialized|could not find account/i.test(all)) {
    return "An account the instruction needs does not exist or is the wrong kind. Check the owner's USDC token account (npm run task -- preflight).";
  }
  if (/Error: insufficient funds/i.test(all)) return "The token account does not hold enough USDC for this transfer.";
  return undefined;
}

export function formatSolanaError(e: unknown): string {
  const x = explainSolanaError(e);
  const lines = [`Error: ${x.message}`];
  for (const c of x.causes) lines.push(`  cause: ${c}`);
  if (x.program_error) lines.push(`  program error: ${x.program_error}`);
  if (x.hint) lines.push(`  hint: ${x.hint}`);
  if (x.logs.length) {
    lines.push("  simulation logs:");
    for (const l of x.logs) lines.push(`    ${l}`);
  } else {
    lines.push("  (the RPC returned no simulation logs)");
  }
  return lines.join("\n");
}
