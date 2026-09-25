import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ledger } from "../lib/ledger";

const fresh = () => new Ledger(path.join(mkdtempSync(path.join(tmpdir(), "ledger-")), "l.jsonl"));

test("events chain by previous_event_hash", () => {
  const l = fresh();
  const a = l.append("d1", "payment_candidate", { amount: "10" });
  const b = l.append("d1", "gate_decision", { decision: "PAY" });
  assert.equal(a.previous_event_hash, null);
  assert.equal(b.previous_event_hash, a.event_hash);
  assert.equal(l.verify(), -1);
});

test("tampering is detected", () => {
  const l = fresh();
  l.append("d1", "payment_candidate", { amount: "10" });
  l.append("d1", "gate_decision", { decision: "BLOCK" });
  const lines = readFileSync(l.file, "utf8").split("\n");
  lines[1] = lines[1].replace("BLOCK", "PAY");
  writeFileSync(l.file, lines.join("\n"));
  assert.equal(l.verify(), 1);
});

test("secrets are redacted", () => {
  const l = fresh();
  const e = l.append("d1", "screening_result", { apiKey: "k", nested: { signature: "0xsig", ok: 1 } });
  assert.deepEqual(e.data, { apiKey: "[redacted]", nested: { signature: "[redacted]", ok: 1 } });
  assert.ok(!readFileSync(l.file, "utf8").includes("0xsig"));
});
