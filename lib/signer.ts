import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
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

const same = (a: PaymentRequirements, b: PaymentRequirements) =>
  a.scheme === b.scheme &&
  a.network === b.network &&
  a.asset.toLowerCase() === b.asset.toLowerCase() &&
  a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
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
  const client = new x402Client()
    .register(approved.network, new ExactEvmScheme(account()))
    .setSpendControls(false)
    .registerPolicy((_v, reqs) => reqs.filter((r) => same(r as PaymentRequirements, approved)))
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      same(selectedRequirements, approved) ? undefined : { abort: true, reason: "requirement differs from gate decision" },
    );
  return client.createPaymentPayload({ ...paymentRequired, accepts: [approved] });
}
