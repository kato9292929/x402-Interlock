import { test } from "node:test";
import assert from "node:assert/strict";
import { codeFilter, confirmOrReroute, ownedSatisfying, routeCheapestOnly, routeCode, type Candidate, type RouteRequest } from "../lib/router";

const P = { from: "2026-09-27", to: "2026-10-03" };
const req: RouteRequest = { purpose: "daily stats", requirements: { period: P, required_fields: ["date", "plays"], min_items: 1 }, max_price_atomic: 100_000n, budget_remaining_atomic: 50_000n };
const c = (id: string, price: number, declared?: Candidate["declared"]): Candidate => ({ id, url: `https://s-${id}/x`, description: id, price_atomic: BigInt(price), ...(declared ? { declared } : {}) });

test("router code: price cap, budget, declared period and fields drop candidates; the cheapest of the rest is chosen", () => {
  const cands = [c("cap", 200_000), c("budget", 60_000), c("old", 10_000, { period: { from: "2025-01-01", to: "2025-12-31" } }), c("nofields", 15_000, { fields: ["date"] }), c("ok2", 40_000), c("ok1", 30_000)];
  const { kept, dropped } = codeFilter(req, cands);
  assert.deepEqual(kept.map((x) => x.id), ["ok2", "ok1"]);
  assert.deepEqual(dropped.map((d) => d.reason), ["OVER_PRICE_CAP", "OVER_BUDGET", "PERIOD_NOT_COVERED", "FIELDS_NOT_COVERED"]);
  const r = routeCode(req, cands);
  assert.equal(r.kind === "buy" && r.candidate.id, "ok1");
  assert.equal(routeCheapestOnly(req, cands)!.id, "old"); // the cheapest-only baseline ignores everything else
});

test("router code: data already obtained (code checks passed, same period, fields covered) means don't buy", () => {
  const owned = [{ decision_id: "d", target: "t", requirements: { period: { from: "2026-09-01", to: "2026-10-07" }, required_fields: ["date", "plays", "listeners"] }, fields_ok: true }];
  assert.ok(ownedSatisfying(req, owned));
  assert.equal(ownedSatisfying(req, [{ ...owned[0], fields_ok: false }]), undefined);
  assert.equal(ownedSatisfying(req, [{ ...owned[0], requirements: { period: { from: "2026-09-28", to: "2026-10-03" }, required_fields: ["date", "plays"] } }]), undefined);
  const r = routeCode(req, [c("a", 1000)], owned);
  assert.deepEqual([r.kind, r.kind === "dont_buy" && r.reason], ["dont_buy", "ALREADY_HAVE"]);
  const none = routeCode(req, [c("cap", 200_000)]);
  assert.deepEqual([none.kind, none.kind === "dont_buy" && none.reason], ["dont_buy", "NO_CANDIDATE_LEFT"]);
});

test("router: a price change after choosing makes it choose again", async () => {
  const cands = [c("a", 10_000), c("b", 20_000)];
  const first = routeCode(req, cands);
  const same = await confirmOrReroute(first, async (x) => x, async (cs) => routeCode(req, cs), cands);
  assert.equal(same.rerouted, false);
  const up = await confirmOrReroute(first, async (x) => ({ ...x, price_atomic: 30_000n }), async (cs) => routeCode(req, cs), cands);
  assert.equal(up.rerouted, true);
  assert.equal(up.choice.kind === "buy" && up.choice.candidate.id, "b");
});
