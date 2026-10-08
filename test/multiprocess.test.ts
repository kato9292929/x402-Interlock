import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Stage 8: several server processes sharing one ledger file. Without the lock, two appends can
// read the same last hash (a forked chain) and two reservations can both see "nothing held".
test("processes sharing one ledger: the hash chain stays intact and only one reserves the same purchase", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "multiproc-"));
  const env = { ...process.env, LEDGER_PATH: path.join(dir, "ledger.jsonl"), DATA_DIR: dir };
  const startAt = Date.now() + 1500;
  const run = (id: number) =>
    new Promise<{ id: string; reserved: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "fixtures", "ledger-writer.ts"), String(id), "40", String(startAt)], { env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${id} exited ${code}: ${err}`))));
    });
  const results = await Promise.all([1, 2, 3, 4].map(run));
  process.env.LEDGER_PATH = env.LEDGER_PATH;
  const { Ledger } = await import("../lib/ledger");
  const l = new Ledger(env.LEDGER_PATH);
  const all = l.readAll();
  assert.equal(all.filter((e) => e.event_type === "allowance_checked").length, 160);
  assert.equal(l.verify(), -1, "hash chain broken");
  assert.equal(results.filter((r) => r.reserved).length, 1, JSON.stringify(results));
  assert.equal(all.filter((e) => e.event_type === "payment_reserved").length, 1);
  assert.equal(all.filter((e) => e.event_type === "payment_result" && e.data.reason === "PURCHASE_IN_FLIGHT").length, 3);
});
