// spec/07 section 4: ask a judge the Spend Guard questions again on the purchases already
// reviewed, without buying anything, so Jev and Clef can be compared on the same purchases
// against the owner's own labels (not on benchmarks).
//
// For each review it rebuilds the state from the ledger (task, seller description, the history
// before that purchase), asks the provider both wordings of the necessity question in separate
// calls, and appends a spend_guard_replay event: probabilities, model string, state hash. The
// state itself is not written (it holds the task purpose and the seller's text).
//
// Run: npm run appe-compare -- --provider typesafe
//      npm run appe-compare -- --provider clef          (CLEF_BASE_URL set; your own server)
// Options: --boundary   only the boundary purchases (see npm run appe-label -- --boundary)
//          --again      ask again even where this provider already answered
//          --timeout ms per call, default 60000 (a self-hosted 27B model can be slow; the
//                       gate's own limit is jev.timeout_ms, this is offline)
import { Ledger } from "../lib/ledger";
import { askSpendGuard, judgeOptions, loadThresholds, spendGuardState, stateSha256 } from "../lib/appe";
import { boundaryOf, replayInput, reviewRows } from "../lib/appe-eval";
import { loadPolicy } from "../lib/policy";
import { getTask } from "../lib/tasks";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const f2 = (v: number | null | undefined) => (v === null || v === undefined ? "  -  " : v.toFixed(2));

async function main() {
  const t = loadThresholds();
  const provider = arg("--provider");
  if (!provider) throw new Error(`usage: npm run appe-compare -- --provider ${Object.keys(t.providers).join("|")}`);
  const base = judgeOptions(t, provider);
  if (base.unavailable) throw new Error(base.unavailable);
  const opts = { ...base, timeoutMs: Number(arg("--timeout") ?? 60_000), cacheMs: 0 };
  const decimals = loadPolicy().token_decimals;

  const ledger = new Ledger();
  const all = ledger.readAll();
  let rows = reviewRows(all);
  if (process.argv.includes("--boundary")) rows = rows.filter((r) => boundaryOf(r) === "boundary");
  const todo = process.argv.includes("--again") ? rows : rows.filter((r) => r.replays[provider]?.status !== "OK" || r.replays[provider]?.model !== opts.expectedModel);
  console.log(`provider ${provider}  ${opts.baseURL}  model ${opts.model}  (${rows.length} reviews, ${todo.length} to ask, ${rows.length - todo.length} already answered by ${opts.expectedModel})`);

  let failedInARow = 0;
  let calls = 0;
  for (const [n, r] of todo.entries()) {
    const input = replayInput(all, r.decision_id, { task: getTask, decimals });
    if ("error" in input) {
      console.log(`[${n + 1}/${todo.length}] ${r.decision_id} skipped: ${input.error}`);
      continue;
    }
    const state = spendGuardState(input, t);
    const sha = stateSha256(state);
    const live = all.find((e) => e.decision_id === r.decision_id && e.event_type === "spend_guard_review")!.data.state_sha256 as string | undefined;
    const sameState = live === undefined ? null : live === sha;
    const { r: a, alt } = await askSpendGuard(state, t, opts, true);
    calls += 2;
    const ok = a.status === "OK";
    const altOk = alt?.status === "OK";
    ledger.append(r.decision_id, "spend_guard_replay", {
      target_decision_id: r.decision_id,
      task_id: r.task_id,
      provider,
      status: a.status,
      ...(ok ? {} : { reason: a.reason }),
      model: ok ? a.model : null,
      necessity_prob: ok ? (a.answers.necessity as { noul: number }).noul : null,
      necessity_alt_prob: altOk ? (alt!.answers.necessity as { noul: number }).noul : null,
      ...(alt && !altOk ? { alt_reason: (alt as { reason: string }).reason } : {}),
      duplicate_prob: ok ? (a.answers.duplicate as { noul: number }).noul : null,
      nature: ok ? (a.answers.nature as { choice: string }).choice : null,
      nature_probabilities: ok ? (a.answers.nature as { probabilities: Record<string, number> }).probabilities : null,
      state_sha256: sha,
      // true: the rebuilt state is byte for byte what the live judge saw. null: the review is
      // older than the hash; the state was rebuilt from the ledger and the seller config.
      state_matches_live: sameState,
      latency_ms: a.latency_ms,
      policy_version: t.policy_version,
    });
    const path = new URL(r.url).pathname.replace("/api/seller/", "");
    console.log(
      `[${n + 1}/${todo.length}] ${path.padEnd(28)} ` +
        (ok
          ? `necessary ${f2((a.answers.necessity as { noul: number }).noul)}  or useful ${altOk ? f2((alt!.answers.necessity as { noul: number }).noul) : "UNAV."}  dup ${f2((a.answers.duplicate as { noul: number }).noul)}  ${(a.answers.nature as { choice: string }).choice.padEnd(12)}`
          : `UNAVAILABLE: ${a.reason}`) +
        `  | live ${f2(r.necessity_alt)}  state ${sameState === null ? "rebuilt" : sameState ? "same" : "DIFFERENT"}  ${a.latency_ms} ms`,
    );
    failedInARow = ok ? 0 : failedInARow + 1;
    if (failedInARow >= 3) throw new Error(`3 calls in a row UNAVAILABLE (last: ${ok ? "" : a.reason}); stopped. Fix the cause and run again: answered ones are kept`);
  }
  console.log(`\ndone: ${calls} calls to ${provider}. Next: npm run appe-label -- --boundary, then npm run appe-metrics -- --boundary`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
