import { readFileSync } from "node:fs";
import path from "node:path";

// What the agent is about to do, not only what it pays. Money rules cannot see a
// disclosed address or a promised discount: those cost 0 and pass any budget.

export const ACTION_TYPES = ["pay", "commit", "disclose", "impersonate"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_POLICIES = ["allow", "ask_human", "deny", "notify"] as const;
export type ActionPolicy = (typeof ACTION_POLICIES)[number];

const DEFAULTS: Record<ActionType, ActionPolicy> = {
  pay: "allow",
  commit: "ask_human",
  disclose: "ask_human",
  impersonate: "deny",
};

export const isActionType = (v: unknown): v is ActionType => ACTION_TYPES.includes(v as ActionType);

/** Unknown or missing entries fall back to the defaults; an invalid value is a config error. */
export function loadActionPolicies(
  file = process.env.ACTIONS_PATH ?? path.join(process.cwd(), "config", "actions.json"),
): Record<ActionType, ActionPolicy> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = {};
  }
  const out = { ...DEFAULTS };
  for (const t of ACTION_TYPES) {
    const v = raw[t];
    if (v === undefined) continue;
    if (!ACTION_POLICIES.includes(v as ActionPolicy)) throw new Error(`config/actions.json: invalid policy "${String(v)}" for ${t}`);
    out[t] = v as ActionPolicy;
  }
  return out;
}
