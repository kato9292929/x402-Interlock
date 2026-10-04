// spec/07 section 4: the owner labels each purchase Spend Guard reviewed: needed / unneeded /
// not sure, one key each. Jev's answer is shown only after the label, so it cannot sway it.
// Labels go to the ledger (owner_label); stop any time with q and run again to continue.
// When every purchase of a task is labelled, it asks whether the task's purpose was met.
// Run: npm run appe-label   (with npm run appe-eval-run finished; labels are ledger events)
import { emitKeypressEvents } from "node:readline";
import { Ledger } from "../lib/ledger";
import { reviewRows, taskLabels, type PurchaseLabel, type TaskLabel } from "../lib/appe-eval";
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
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (it reads single key presses)");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  const ledger = new Ledger();
  const all = ledger.readAll();
  const rows = reviewRows(all);
  const todo = rows.filter((r) => !r.label);
  const doneTasks = taskLabels(all);
  console.log(`${rows.length} reviewed purchases, ${rows.length - todo.length} labelled, ${todo.length} to go.`);
  console.log("Keys: 1 = needed (必要)   2 = not needed (不要)   3 = not sure (わからない)   q = stop (resume later)\n");
  let i = rows.length - todo.length;
  for (const r of todo) {
    i++;
    const task = getTask(r.task_id);
    const amount = `${(Number(r.amount) / 1e6).toFixed(2)} USDC`;
    console.log(`[${i}/${rows.length}] task: ${oneLine(task?.purpose ?? r.task_id, 70)}`);
    console.log(`        buy:  ${new URL(r.url).pathname}  ${amount}  "${oneLine(r.description, 90)}"`);
    process.stdout.write("        your call (1/2/3, q): ");
    const k = await key(Object.keys(KEYS));
    if (k === "q") break;
    ledger.append(r.decision_id, "owner_label", { target_decision_id: r.decision_id, task_id: r.task_id, label: KEYS[k] });
    console.log(KEYS[k]);
    console.log(
      r.jev_status === "OK"
        ? `        Jev:  necessity ${fmt(r.necessity)} (necessary or useful ${fmt(r.necessity_alt)})  duplicate ${fmt(r.duplicate)}  nature ${r.nature}  -> would_have ${r.would_have}\n`
        : `        Jev:  UNAVAILABLE\n`,
    );
    // Last purchase of this task labelled: ask about the task itself.
    const remaining = todo.slice(todo.indexOf(r) + 1).some((x) => x.task_id === r.task_id);
    if (!remaining && !doneTasks.has(r.task_id)) {
      process.stdout.write(`        task done? "${oneLine(task?.purpose ?? r.task_id, 60)}": purpose met with these purchases? (1 yes / 2 no / 3 not sure, q): `);
      const t = await key(Object.keys(TASK_KEYS));
      if (t === "q") break;
      ledger.append(r.task_id, "owner_task_label", { task_id: r.task_id, label: TASK_KEYS[t] });
      doneTasks.set(r.task_id, TASK_KEYS[t]);
      console.log(`${TASK_KEYS[t]}\n`);
    }
  }
  process.stdin.setRawMode(false);
  const left = reviewRows(new Ledger().readAll()).filter((r) => !r.label).length;
  console.log(left ? `\nstopped: ${left} still to label. Run npm run appe-label again to continue.` : "\nall labelled. Next: npm run appe-metrics");
  process.exit(0);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
