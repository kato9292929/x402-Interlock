// spec/07 section 4: the owner labels each purchase Spend Guard reviewed: needed / unneeded /
// not sure, one key each. Jev's answer is shown only after the label, so it cannot sway it.
// Labels go to the ledger (owner_label); stop any time with q and run again to continue.
// When every purchase of a task is labelled, it asks whether the task's purpose was met.
// Run: npm run appe-label              (with npm run appe-eval-run finished; labels are ledger events)
//      npm run appe-label -- --review  (go through all of them again, Enter keeps a label, 1/2/3 changes it)
//      npm run appe-label -- --reset   (withdraw every label so far; recorded in the ledger with the reason)
//      npm run appe-label -- --boundary (only purchases with "necessary or useful" in 0.30-0.85 for any
//                                        judge; the rest are skipped, not labelled, and left out of
//                                        npm run appe-metrics -- --boundary. Combines with --review)
import { emitKeypressEvents } from "node:readline";
import { Ledger } from "../lib/ledger";
import { BOUNDARY, boundaryOf, reviewRows, sellerDescription, taskLabels, type PurchaseLabel, type ReviewRow, type TaskLabel } from "../lib/appe-eval";
import { getTask } from "../lib/tasks";

const KEYS: Record<string, PurchaseLabel> = { "1": "needed", "2": "unneeded", "3": "unsure", y: "needed", n: "unneeded", s: "unsure" };
const TASK_KEYS: Record<string, TaskLabel> = { "1": "achieved", "2": "not_achieved", "3": "unsure", y: "achieved", n: "not_achieved", s: "unsure" };
const oneLine = (s: string | null, n: number) => (s ?? "(no description)").replace(/\s+/g, " ").slice(0, n);
const fmt = (v: number | null) => (v === null ? "-" : v.toFixed(2));

function key(allowed: string[]): Promise<string> {
  return new Promise((resolve) => {
    const onKey = (str: string | undefined, k: { ctrl?: boolean; name?: string }) => {
      if (k?.ctrl && k.name === "c") process.exit(130);
      const c = (str ?? "").toLowerCase();
      if (c === "q" || allowed.includes(c)) {
        process.stdin.off("keypress", onKey);
        resolve(c);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

async function main() {
  if (process.argv.includes("--reset")) {
    const i = process.argv.indexOf("--reason");
    const reason = i > 0 ? process.argv[i + 1] : "withdrawn by the owner";
    new Ledger().append("appe-labels", "owner_label_reset", { reason });
    console.log(`all labels so far withdrawn (${reason}); they stay in the ledger but no longer count. Run npm run appe-label to start again.`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (it reads single key presses)");
  const review = process.argv.includes("--review");
  const boundary = process.argv.includes("--boundary");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  const ledger = new Ledger();
  const all = ledger.readAll();
  const everything = reviewRows(all);
  const rows = boundary ? everything.filter((r) => boundaryOf(r) === "boundary") : everything;
  if (boundary) {
    const c = (k: string) => everything.filter((r) => boundaryOf(r) === k).length;
    console.log(
      `boundary only: "necessary or useful" ${BOUNDARY.low.toFixed(2)}-${BOUNDARY.high.toFixed(2)} for any judge (live or npm run appe-compare): ${rows.length} of ${everything.length}. ` +
        `Skipped, not labelled: ${c("above")} above, ${c("below")} below, ${c("no_value")} with no answer.`,
    );
  }
  // Normal: the unlabelled ones. --review: every one, showing the current label, to change any.
  const list = review ? rows : rows.filter((r) => !r.label);
  const doneTasks = taskLabels(all);
  console.log(`${rows.length} reviewed purchases, ${rows.filter((r) => r.label).length} labelled, ${rows.filter((r) => !r.label).length} to go.${review ? " Review mode: every purchase, latest label shown." : ""}`);
  console.log("Keys: 1 = needed (必要)   2 = not needed (不要)   3 = not sure (わからない)   b = back one   " + (review ? "Enter = keep   " : "") + "q = stop (resume later)\n");
  const allowed = [...Object.keys(KEYS), "b", ...(review ? ["\r", "\n"] : [])];
  let i = 0;
  while (i < list.length) {
    const r = list[i];
    const task = getTask(r.task_id);
    const amount = `${(Number(r.amount) / 1e6).toFixed(2)} USDC`;
    const current = labelOf(r.decision_id);
    console.log(`[${rows.indexOf(r) + 1}/${rows.length}] task: ${oneLine(task?.purpose ?? r.task_id, 70)}`);
    console.log(`        buy:  ${new URL(r.url).pathname}  ${amount}  "${oneLine(sellerDescription(r.url, r.description), 90)}"`);
    process.stdout.write(`        your call (1/2/3, b, q)${current ? ` [now: ${current}]` : ""}: `);
    const k = await key(allowed);
    if (k === "q") break;
    if (k === "b") {
      console.log("back");
      i = Math.max(0, i - 1);
      continue;
    }
    if (k === "\r" || k === "\n") {
      console.log(`kept ${current ?? "unlabelled"}`);
      i++;
      continue;
    }
    // The latest label for a purchase is the one that counts; earlier ones stay in the ledger.
    ledger.append(r.decision_id, "owner_label", { target_decision_id: r.decision_id, task_id: r.task_id, label: KEYS[k] });
    console.log(KEYS[k]);
    console.log(judgeLines(r) + "\n");
    // Last purchase of this task in the list: ask about the task itself (or again, in review mode).
    const lastOfTask = !list.slice(i + 1).some((x) => x.task_id === r.task_id);
    if (lastOfTask && (review || !doneTasks.has(r.task_id))) {
      const now = doneTasks.get(r.task_id);
      process.stdout.write(`        task done? "${oneLine(task?.purpose ?? r.task_id, 60)}": purpose met with these purchases? (1 yes / 2 no / 3 not sure, q)${now ? ` [now: ${now}]` : ""}: `);
      const t = await key(Object.keys(TASK_KEYS));
      if (t === "q") break;
      ledger.append(r.task_id, "owner_task_label", { task_id: r.task_id, label: TASK_KEYS[t] });
      doneTasks.set(r.task_id, TASK_KEYS[t]);
      console.log(`${TASK_KEYS[t]}\n`);
    }
    i++;
  }
  process.stdin.setRawMode(false);
  const after = reviewRows(new Ledger().readAll()).filter((r) => !boundary || boundaryOf(r) === "boundary");
  const left = after.filter((r) => !r.label).length;
  const flag = boundary ? " -- --boundary" : "";
  console.log(left ? `\nstopped: ${left} still to label. Run npm run appe-label${flag} again to continue.` : `\nall labelled. Next: npm run appe-metrics${flag}  (to change a label: npm run appe-label -- --review${boundary ? " --boundary" : ""})`);
  process.exit(0);
}

/** Every judge's answer, shown after the label: the live one, then each replay. */
function judgeLines(r: ReviewRow): string {
  const line = (name: string, status: string, nec: number | null, alt: number | null, dup: number | null, nature: string | null) =>
    status === "OK" ? `        ${name.padEnd(9)} necessary ${fmt(nec)}  or useful ${fmt(alt)}  duplicate ${fmt(dup)}  nature ${nature}` : `        ${name.padEnd(9)} ${status}`;
  return [
    line(`${r.provider}:`, r.jev_status, r.necessity, r.necessity_alt, r.duplicate, r.nature) + (r.jev_status === "OK" ? `  -> would_have ${r.would_have}` : ""),
    ...Object.entries(r.replays).map(([p, j]) => line(`${p}*:`, j.status, j.necessity, j.necessity_alt, j.duplicate, j.nature)),
  ].join("\n") + (Object.keys(r.replays).length ? "\n        (* = replay, npm run appe-compare)" : "");
}

/** The latest label in the ledger for one purchase (read fresh, so "b" shows what was just set). */
function labelOf(decision_id: string): string | undefined {
  return reviewRows(new Ledger().readAll()).find((r) => r.decision_id === decision_id)?.label;
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
