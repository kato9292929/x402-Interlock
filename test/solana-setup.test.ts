import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { envValue, generateSolanaKeypair, setEnvValue } from "../lib/solana/setup";

test("generated keypair is in solana-keygen format and loads back to the same address", async () => {
  const kp = await generateSolanaKeypair();
  assert.equal(kp.secretKey.length, 64);
  assert.equal((await createKeyPairSignerFromBytes(kp.secretKey)).address, kp.address);
  assert.notEqual((await generateSolanaKeypair()).address, kp.address);
});

test("envValue reads values the way the env file is meant, ignoring trailing comments", () => {
  const text = "A=1\nAGENT_SOLANA_ADDRESS=        # the agent's public key\nB='x y'\nB2=\"q\" # c\n";
  assert.equal(envValue(text, "AGENT_SOLANA_ADDRESS"), "");
  assert.equal(envValue(text, "A"), "1");
  assert.equal(envValue(text, "B"), "x y");
  assert.equal(envValue(text, "B2"), "q");
  assert.equal(envValue(text, "MISSING"), "");
});

test("setEnvValue fills an empty line in place, appends on its own line otherwise, never overwrites", () => {
  const copied = "X=1\nSELLER_SOLANA_PAY_TO=        # demo seller\nY=2\n";
  assert.equal(setEnvValue(copied, "SELLER_SOLANA_PAY_TO", "Abc"), "X=1\nSELLER_SOLANA_PAY_TO=Abc\nY=2\n");
  // no trailing newline on the last line: the new value must not join it
  assert.equal(setEnvValue("X=1", "AGENT_SOLANA_ADDRESS", "Def"), "X=1\nAGENT_SOLANA_ADDRESS=Def\n");
  assert.equal(setEnvValue("", "K", "v"), "K=v\n");
  assert.throws(() => setEnvValue("K=already\n", "K", "v"), /already set/);
});
