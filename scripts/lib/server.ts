import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// For the devnet run scripts: use the Interlock server already answering at `base`, or start
// `next dev` for the duration of the script and stop it at the end (also on Ctrl+C or an error).
// The started server's output goes to data/<name>-server.log, so a crash can be shown.

export interface Server {
  /** true when this script started the server (and will stop it) */
  started: boolean;
  log?: string;
  /** stops a server this script started and waits until it has exited (SIGKILL after 5 s) */
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function answers(base: string, headers: Record<string, string>): Promise<number | null> {
  try {
    const res = await fetch(`${base}/api/tasks`, { headers, signal: AbortSignal.timeout(60_000) });
    return res.status;
  } catch {
    return null;
  }
}

export async function ensureServer(base: string, headers: Record<string, string>, opts: { name: string; env?: Record<string, string>; readyTimeoutMs?: number }): Promise<Server> {
  const already = await answers(base, headers);
  if (already !== null) {
    if (already === 401) throw new Error(`the server at ${base} refused OWNER_TOKEN: it was started with another .env.local; stop it and run this again`);
    console.log(`using the server already running at ${base} (its settings are the ones it was started with)`);
    return { started: false, async stop() {} };
  }

  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error(`nothing answers at ${base}, and it is not local, so it cannot be started from here`);
  const port = url.port || "3000";
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const log = path.join(dataDir, `${opts.name}-server.log`);
  const fd = openSync(log, "w");
  const nextBin = createRequire(path.join(process.cwd(), "package.json")).resolve("next/dist/bin/next");
  console.log(`starting the server: next dev -p ${port} (log: ${path.relative(process.cwd(), log)})`);
  const child: ChildProcess = spawn(process.execPath, [nextBin, "dev", "-p", port], {
    cwd: process.cwd(),
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", fd, fd],
    detached: true, // its own process group, so stop() takes next's workers down with it
  });
  closeSync(fd);
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));

  const stop = () => {
    if (exited !== undefined || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  const onSignal = () => {
    stop();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", stop);

  const tail = () => readFileSync(log, "utf8").split("\n").slice(-20).join("\n");
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`the server stopped while starting (exit ${exited}). Last lines of ${log}:\n${tail()}`);
    const status = await answers(base, headers);
    if (status === 401) {
      stop();
      throw new Error("the server refused OWNER_TOKEN: check .env.local");
    }
    if (status !== null) {
      console.log("server ready");
      return {
        started: true,
        log,
        async stop() {
          if (exited === undefined) {
            const gone = new Promise<void>((r) => child.once("exit", () => r()));
            stop();
            const killed = setTimeout(() => {
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {
                /* already gone */
              }
            }, 5000);
            await gone;
            clearTimeout(killed);
          }
          console.log("server stopped");
        },
      };
    }
    await sleep(1000);
  }
  stop();
  throw new Error(`the server did not answer within ${Math.round((opts.readyTimeoutMs ?? 180_000) / 1000)} s. Last lines of ${log}:\n${tail()}`);
}

/** The server this script started has crashed: say so with its log, instead of "fetch failed". */
export function explainFetchError(e: unknown, server: Server): Error {
  const err = e as Error;
  if (server.log && /fetch failed|ECONNREFUSED|ECONNRESET/i.test(String(err.message) + String((err as { cause?: unknown }).cause ?? ""))) {
    const tail = readFileSync(server.log, "utf8").split("\n").slice(-20).join("\n");
    return new Error(`lost the server (${err.message}). Last lines of ${server.log}:\n${tail}`);
  }
  return err;
}
