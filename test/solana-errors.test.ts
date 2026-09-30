import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
} from "@solana/kit";
import { SUBSCRIPTIONS_ERROR__INVALID_SUBSCRIPTION_AUTHORITY_PDA as SA_PDA, SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";
import { explainSolanaError, formatSolanaError } from "../lib/solana/errors";

// Real kit error objects, shaped the way sendTransaction throws them on a preflight failure.
const preflight = (logs: string[], cause: unknown) =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    innerInstructions: null,
    loadedAccountsDataSize: undefined,
    logs,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: 1234n,
    cause,
  } as never);

test("simulation logs and the program error are surfaced, not just the message", () => {
  const logs = [
    `Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} invoke [1]`,
    "Program log: Error: something",
    `Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} failed: custom program error: 0x${SA_PDA.toString(16)}`,
  ];
  const e = preflight(logs, new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: SA_PDA, index: 0 }));
  const x = explainSolanaError(e);
  assert.deepEqual(x.logs, logs);
  assert.ok(x.causes.some((c) => c.includes(`custom error ${SA_PDA}`)));
  // decoded to the SDK's own constant name; never "undefined"
  assert.match(x.program_error ?? "", /^Subscriptions program: INVALID_SUBSCRIPTION_AUTHORITY_PDA/);
  assert.doesNotMatch(x.program_error ?? "", /undefined/);
  const text = formatSolanaError(e);
  assert.match(text, /simulation logs:/);
  assert.match(text, /failed: custom program error: 0x/);
});

test("a code the SDK does not define is reported as unknown, not undefined", () => {
  const logs = [`Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} failed: custom program error: 0x1`];
  const x = explainSolanaError(preflight(logs, new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 1, index: 0 })));
  assert.equal(x.program_error, "Subscriptions program: unknown error code 1");
});

test("no SOL for fees gives an actionable hint", () => {
  const e = preflight(["Attempt to debit an account but found no record of a prior credit."], new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE));
  assert.match(explainSolanaError(e).hint ?? "", /no SOL/);
});

test("non-kit errors still print, with a note that there were no logs", () => {
  assert.match(formatSolanaError(new Error("fetch failed")), /Error: fetch failed[\s\S]*no simulation logs/);
});
