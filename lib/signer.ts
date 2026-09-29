import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { gateSigner, isSolanaNetwork, solanaRpcUrl } from "./solana/config";
import { privateKeyToAccount } from "viem/accounts";

// The buyer key lives only on the x402 Interlock server. The agent never holds it,
// so the only way to get a payment signed is through a gate decision.

function account() {
  const pk = process.env.BUYER_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("BUYER_PRIVATE_KEY is not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

export function buyerAddress(): string {
  return account().address;
}

/**
 * EVM address used as `from` in the Scan Message stand-in. Intercepta screens Base mainnet
 * only, so a Solana payment is screened as its Base counterpart; without an EVM buyer key,
 * SCREENING_FROM_ADDRESS provides that stand-in.
 */
export function screeningFromAddress(): string {
  if (process.env.BUYER_PRIVATE_KEY) return buyerAddress();
  const a = process.env.SCREENING_FROM_ADDRESS;
  if (!a) throw new Error("set BUYER_PRIVATE_KEY or SCREENING_FROM_ADDRESS (EVM stand-in for Scan Message)");
  return a;
}

// EVM addresses are case-insensitive hex; Solana base58 addresses are case-sensitive.
const eqAddr = (network: string, a: string, b: string) => (isSolanaNetwork(network) ? a === b : a.toLowerCase() === b.toLowerCase());
const same = (a: PaymentRequirements, b: PaymentRequirements) =>
  a.scheme === b.scheme &&
  a.network === b.network &&
  eqAddr(a.network, a.asset, b.asset) &&
  eqAddr(a.network, a.payTo, b.payTo) &&
  a.amount === b.amount;

/**
 * Sign exactly the requirement the gate approved, and nothing else.
 * Spend limits are enforced by the gate policy, so the SDK's default $1 cap is
 * replaced by a hook that refuses any requirement other than `approved`.
 */
export async function signApproved(
  paymentRequired: PaymentRequired,
  approved: PaymentRequirements,
): Promise<PaymentPayload> {
  // On Solana the payer is the gate's key: the same key the task's Allowance delegates to,
  // funded per payment by a pull under that Allowance (see lib/gate.ts execute()).
  const scheme = isSolanaNetwork(approved.network)
    ? new ExactSvmScheme(await gateSigner(), { rpcUrl: solanaRpcUrl() })
    : new ExactEvmScheme(account());
  const client = new x402Client()
    .register(approved.network as `${string}:${string}`, scheme)
    .setSpendControls(false)
    .registerPolicy((_v, reqs) => reqs.filter((r) => same(r as PaymentRequirements, approved)))
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      same(selectedRequirements, approved) ? undefined : { abort: true, reason: "requirement differs from gate decision" },
    );
  return client.createPaymentPayload({ ...paymentRequired, accepts: [approved] });
}
