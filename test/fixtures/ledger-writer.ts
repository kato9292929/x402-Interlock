// Child process for test/multiprocess.test.ts: appends events and tries one reservation on the
// shared ledger (LEDGER_PATH), all at once with its siblings.
import { Ledger } from "../../lib/ledger";
import { tryReservePurchase } from "../../lib/gate";

const [id, n, startAt] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const l = new Ledger();
while (Date.now() < startAt) {
  /* start together */
}
for (let i = 0; i < n; i++) l.append(`w${id}`, "allowance_checked", { writer: id, i });
const r = tryReservePurchase(l, `00000000-0000-4000-8000-00000000000${id}`, { task_id: "task_shared", run_id: "task_shared", url: "https://seller/x", amount: "100" });
process.stdout.write(JSON.stringify({ id, reserved: r === undefined }));
