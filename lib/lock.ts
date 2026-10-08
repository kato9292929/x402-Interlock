import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

// One lock around the ledger, shared by every process on the machine (spec/07 section 8,
// stage 8). Within one process, appends are already ordered (sync I/O). Across processes that
// share the ledger file, two appends could both read the same last hash and fork the chain, and
// two reservations could both see "nothing held". The lock is a file created with O_EXCL:
// exactly one process can create it. It is re-entrant within a process, so a reservation can
// check and append under one hold.
//
// A lock left by a crashed process is taken over after STALE_MS (its mtime), which is far longer
// than any critical section here (a ledger read and one append).

const STALE_MS = 10_000;
const WAIT_MS = 15_000;
let depth = 0;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withFileLock<T>(lockFile: string, fn: () => T): T {
  if (depth > 0) {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  }
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > STALE_MS) unlinkSync(lockFile);
      } catch {
        /* removed by its owner in the meantime */
      }
      if (Date.now() > deadline) throw new Error(`ledger lock ${lockFile} held for more than ${WAIT_MS} ms`);
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    try {
      unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }
}
