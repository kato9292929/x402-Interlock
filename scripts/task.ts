// Owner CLI for tasks. Uses OWNER_TOKEN; the agent's token cannot do any of this.
//
//   npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
//   npm run task -- list
//   npm run task -- show task_...
//   npm run task -- close task_...          # revokes the Allowance on chain (irreversible)
//   npm run task -- close-all [--dry-run]   # every task not yet closed; starts the server if none runs (irreversible)
//   npm run task -- preflight               # check SOL, the owner's USDC token account and the authority (direct, read-only)
//   npm run task -- init-authority          # one-time: owner's SubscriptionAuthority for USDC (direct, needs OWNER_SOLANA_PRIVATE_KEY)
//   npm run task -- new-address seller --env SELLER_SOLANA_PAY_TO   # new keypair in keys/seller.json; address into .env.local
//   npm run task -- set-env TYPESAFE_API_KEY   # prompts for the value; writes .env.local; never overwrites, never prints it
//   npm run task -- new-token OWNER_TOKEN   # random token into .env.local; never overwrites, never equal to AGENT_TOKEN
//   npm run task -- protect add address home      # register the owner's data (prompts for the value; server-side only)
//   npm run task -- protect list | protect remove home
//   npm run task -- release <decision_id> --reason "pull not on chain, seller not paid"
//                                           # owner: free a purchase whose payment outcome was unknown
//                                           # (unconfirmed pull / no answer from the seller), after checking the chain
//   npm run task -- reconcile [--dry-run]   # settle payments whose Allowance pull timed out, from the chain (direct)
//   npm run task -- resume <task_id> --reason "..."   # resume a task stopped after payment failures in a row
//   npm run task -- seller-account          # create the seller's USDC token account, paid by the owner (direct)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { releaseReservation } from "../lib/gate";
import { ensureServer } from "./lib/server";
import { reconcileUnconfirmed } from "../lib/reconcile";
import { resumeTask } from "../lib/tasks";
import { SolanaAllowanceChain, SolanaSetupError } from "../lib/solana/allowance";
import { formatSolanaError } from "../lib/solana/errors";
import { addProtected, maskedProtected, removeProtected } from "../lib/protect";
import { createInterface } from "node:readline/promises";
import { envValue, generateSolanaKeypair, setEnvValue, setNewToken } from "../lib/solana/setup";

const ENV_FILE = ".env.local";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const headers = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) {
    // The API returns the chain error already explained (causes, program error, logs).
    const d = json.details as { causes?: string[]; program_error?: string; hint?: string; logs?: string[] } | undefined;
    const lines = [`HTTP ${res.status}: ${json.error}`];
    for (const c of d?.causes ?? []) lines.push(`  cause: ${c}`);
    if (d?.program_error) lines.push(`  program error: ${d.program_error}`);
    if (d?.hint) lines.push(`  hint: ${d.hint}`);
    if (d?.logs?.length) lines.push("  simulation logs:", ...d.logs.map((l) => `    ${l}`));
    throw new SolanaSetupError(lines.join("\n"));
  }
  return json;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "open") {
    const t = await call("POST", "/api/tasks", {
      purpose: arg("--purpose") ?? "",
      budget: { amount: arg("--budget") ?? "", asset: "USDC" },
      expires_at: arg("--expires") ?? new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nAllowance: https://explorer.solana.com/address/${t.allowance.pubkey}?cluster=devnet`);
    console.log(`Create tx: https://explorer.solana.com/tx/${t.allowance.create_tx}?cluster=devnet`);
  } else if (cmd === "list") {
    console.log(JSON.stringify(await call("GET", "/api/tasks"), null, 2));
  } else if (cmd === "show") {
    console.log(JSON.stringify(await call("GET", `/api/tasks/${process.argv[3]}`), null, 2));
  } else if (cmd === "close") {
    const t = await call("POST", `/api/tasks/${process.argv[3]}/close`);
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nRevoke tx: https://explorer.solana.com/tx/${t.revoke_tx}?cluster=devnet`);
  } else if (cmd === "close-all") {
    await closeAll(process.argv.includes("--dry-run"));
  } else if (cmd === "preflight") {
    const r = await new SolanaAllowanceChain().preflight();
    console.log(JSON.stringify(r, null, 2));
    console.log(r.problems.length ? `\n${r.problems.length} problem(s):\n  - ${r.problems.join("\n  - ")}` : "\nall set");
    if (r.warnings.length) console.log(`\nwarning(s):\n  - ${r.warnings.join("\n  - ")}`);
    if (!r.subscription_authority.exists) console.log("SubscriptionAuthority not set up yet: run `npm run task -- init-authority`");
  } else if (cmd === "init-authority") {
    const r = await new SolanaAllowanceChain().initOwnerAuthority();
    console.log(JSON.stringify(r, null, 2));
    if ("signature" in r) console.log(`\nhttps://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    else console.log("\nalready set up; nothing to do");
  } else if (cmd === "new-address") {
    await newAddress(process.argv[3], arg("--env"));
  } else if (cmd === "protect") {
    await protect(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
  } else if (cmd === "set-env") {
    await setEnv(process.argv[3]);
  } else if (cmd === "new-token") {
    newToken(process.argv[3]);
  } else if (cmd === "reconcile") {
    const rows = await reconcileUnconfirmed({ dryRun: process.argv.includes("--dry-run") });
    if (!rows.length) console.log("no payment with an unknown outcome");
    for (const r of rows) console.log(`${r.outcome.padEnd(16)} ${r.decision_id}  task ${r.task_id}  ${r.amount} atomic  ${r.reason}\n    ${r.detail}`);
    if (process.argv.includes("--dry-run") && rows.length) console.log("\n--dry-run: nothing written");
  } else if (cmd === "resume") {
    const id = process.argv[3];
    if (!id) throw new SolanaSetupError('usage: npm run task -- resume <task_id> --reason "what was wrong and why it is fixed"');
    try {
      resumeTask(id, arg("--reason") ?? "");
    } catch (e) {
      throw new SolanaSetupError((e as Error).message);
    }
    console.log(`resumed ${id}: payment failures before now no longer stop it`);
  } else if (cmd === "release") {
    // Direct, like protect: the owner runs this on the gate's machine; it appends to the ledger.
    const id = process.argv[3];
    if (!id) throw new Error('usage: npm run task -- release <decision_id> --reason "what you checked on chain"');
    let held;
    try {
      held = releaseReservation(id, arg("--reason") ?? "");
    } catch (e) {
      throw new SolanaSetupError((e as Error).message); // a ledger answer, not a chain error
    }
    console.log(`released ${id} (was ${held.reason}). The same purchase can be decided again; the release and its reason are in the ledger.`);
  } else if (cmd === "seller-account") {
    const r = await new SolanaAllowanceChain().createSellerTokenAccount();
    console.log(JSON.stringify(r, null, 2));
    if ("signature" in r) console.log(`\nhttps://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    else console.log("\nalready exists; nothing to do");
  } else {
    console.log("usage: npm run task -- open|list|show|close|close-all|reconcile|resume|preflight|init-authority|new-address|new-token|set-env|protect|release|seller-account");
  }
}

/** Close every task that is not closed yet: each Allowance is revoked on chain. One failure does not stop the rest. */
async function closeAll(dry: boolean) {
  const server = await ensureServer(BASE, headers, { name: "task-close-all" });
  try {
    const open = ((await call("GET", "/api/tasks")) as { task_id: string; status: string; purpose: string; budget: { amount: string } }[]).filter((t) => t.status !== "closed");
    console.log(`${open.length} task(s) not closed${dry ? " (--dry-run: nothing revoked)" : ""}`);
    let failed = 0;
    for (const t of open) {
      if (dry) {
        console.log(`  ${t.task_id}  ${t.budget.amount} USDC  "${t.purpose.slice(0, 60)}"`);
        continue;
      }
      try {
        const c = await call("POST", `/api/tasks/${t.task_id}/close`);
        console.log(`  closed ${t.task_id}  revoke https://explorer.solana.com/tx/${c.revoke_tx}?cluster=devnet`);
      } catch (e) {
        failed++;
        console.log(`  FAILED ${t.task_id}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    if (failed) throw new SolanaSetupError(`${failed} task(s) could not be closed; run again, or close them one by one to see the full error`);
  } finally {
    await server.stop();
  }
}

// The owner's protected data, stored in data/protected.json on this machine only. The value is
// asked for interactively when not given, so it does not end up in the shell history.
async function protect(sub: string | undefined, kind: string | undefined, label: string | undefined, value: string | undefined) {
  if (sub === "list") {
    console.log(JSON.stringify(maskedProtected(), null, 2));
  } else if (sub === "remove") {
    if (!kind) throw new SolanaSetupError("usage: npm run task -- protect remove <label>");
    console.log(removeProtected(kind) ? `removed ${kind}` : `no entry named ${kind}`);
  } else if (sub === "add") {
    if (!kind || !label) throw new SolanaSetupError("usage: npm run task -- protect add <address|phone|email|text> <label> [value]");
    let v = value;
    if (v === undefined) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      v = await rl.question(`${kind} for "${label}": `);
      rl.close();
    }
    try {
      const e = addProtected(kind, label, v);
      console.log(JSON.stringify({ registered: `owner.${e.label}`, kind: e.kind, stored_in: "data/protected.json (this machine only; never in the ledger)" }, null, 2));
    } catch (e) {
      throw new SolanaSetupError((e as Error).message);
    }
  } else {
    throw new SolanaSetupError("usage: npm run task -- protect add|list|remove");
  }
}

// A value you were given (an API key) written into .env.local without editing the file by hand.
// Asked for at a prompt so it stays out of the shell history; not printed back.
async function setEnv(name: string | undefined) {
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new SolanaSetupError("usage: npm run task -- set-env NAME   (e.g. TYPESAFE_API_KEY)");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const value = (await rl.question(`${name}: `)).trim();
  rl.close();
  if (!value) throw new SolanaSetupError("empty value; nothing written");
  if (/\s/.test(value)) {
    // Say what the pasted text looked like without echoing the secret: the pieces' lengths, and
    // the first piece only when it is a well-known prefix rather than part of the key.
    const parts = value.split(/\s+/);
    const prefix = /^(bearer|authorization:?|key:?|api[-_]?key:?)$/i.test(parts[0]) || /^[A-Z][A-Z0-9_]*=$/.test(parts[0]) ? ` It starts with "${parts[0]}", which is not part of the key.` : "";
    throw new SolanaSetupError(
      `the value contains whitespace (${parts.length} pieces, lengths ${parts.map((x) => x.length).join(", ")}); nothing written.${prefix} Copy only the key itself (the console's Copy button), then run this again.`,
    );
  }
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  let next: string;
  try {
    next = setEnvValue(envText, name, value);
  } catch (e) {
    throw new SolanaSetupError((e as Error).message);
  }
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
  console.log(JSON.stringify({ name, env: `${name} written to ${ENV_FILE}`, length: value.length }, null, 2));
}

// A random bearer token written straight into .env.local, so nobody edits the file by hand.
// The value is not printed: it is a credential, and .env.local is where it is read from.
function newToken(name: string | undefined) {
  if (!name) throw new SolanaSetupError("usage: npm run task -- new-token OWNER_TOKEN");
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  let next: string;
  try {
    next = setNewToken(envText, name, process.env);
  } catch (e) {
    throw new SolanaSetupError((e as Error).message);
  }
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
  console.log(JSON.stringify({ name, env: `${name} written to ${ENV_FILE}`, length: envValue(next, name).length }, null, 2));
}

// A demo address (agent or seller). The secret key goes to keys/<name>.json (git-ignored, in
// solana-keygen's format) so the funds stay recoverable; only the public address goes into .env.local.
async function newAddress(name: string | undefined, envName: string | undefined) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new SolanaSetupError("usage: npm run task -- new-address <name> [--env VAR]   (name: a-z, 0-9, -)");
  const file = `keys/${name}.json`;
  if (existsSync(file)) throw new SolanaSetupError(`${file} already exists; not overwriting. Use another name or delete it first`);
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const kp = await generateSolanaKeypair();
  // Check .env.local first, so a refusal leaves no orphan key file behind.
  let nextEnv: string | undefined;
  try {
    nextEnv = envName ? setEnvValue(envText, envName, kp.address) : undefined;
  } catch (e) {
    throw new SolanaSetupError((e as Error).message);
  }
  mkdirSync("keys", { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + "\n", { mode: 0o600 });
  if (nextEnv !== undefined) writeFileSync(ENV_FILE, nextEnv);
  console.log(JSON.stringify({ name, address: kp.address, keypair_file: file, env: envName ? `${envName} written to ${ENV_FILE}` : undefined }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  // Setup problems are already written for a person; anything else is a chain error whose
  // simulation logs and causes would be lost by printing only e.message.
  console.error(e instanceof SolanaSetupError ? e.message : formatSolanaError(e));
  process.exit(1);
});
