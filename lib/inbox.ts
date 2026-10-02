import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The demo's one outbound channel: the venue's inbox. Only the gate writes to it (lib/gate.ts),
// after the message has been judged and, if needed, approved. It stands in for an email or chat
// API whose credentials the gate holds and the agent does not. The /inbox page shows it as the
// recipient sees it.
//
// The message body is stored here, not in the ledger: this file is the recipient's side.

export const CHANNELS = ["venue-inbox"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (v: unknown): v is Channel => CHANNELS.includes(v as Channel);

export interface Delivered {
  message_id: string;
  decision_id: string;
  channel: Channel;
  to: string;
  body: string;
  delivered_at: string;
}

const DATA = () => process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const inboxFile = () => path.join(DATA(), "inbox.jsonl");

export function deliver(decision_id: string, channel: Channel, to: string, body: string): Delivered {
  const msg: Delivered = { message_id: randomUUID(), decision_id, channel, to, body, delivered_at: new Date().toISOString() };
  mkdirSync(DATA(), { recursive: true });
  appendFileSync(inboxFile(), JSON.stringify(msg) + "\n", { mode: 0o600 });
  return msg;
}

/** Newest first. */
export function readInbox(): Delivered[] {
  if (!existsSync(inboxFile())) return [];
  return readFileSync(inboxFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Delivered)
    .reverse();
}
