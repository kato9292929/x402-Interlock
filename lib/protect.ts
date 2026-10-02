import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// The owner's protected data, and the deterministic check of an outgoing message against it.
//
// The values (an address, a phone number) live only in data/protected.json on the server. They
// are never written to the ledger, never sent to the agent, and never printed by the CLI in full.
// Detection reports which entry matched and which parts of it, never the matched text.

export type ProtectedKind = "address" | "phone" | "email" | "text";
export const PROTECTED_KINDS: ProtectedKind[] = ["address", "phone", "email", "text"];

export interface ProtectedEntry {
  label: string;
  kind: ProtectedKind;
  value: string;
  added_at: string;
}

export interface Detection {
  type: "disclose";
  /** "protected" = one of the owner's registered values; "pattern" = looks like personal data */
  source: "protected" | "pattern";
  /** owner.<label> for a registered value, or the pattern's name */
  field: string;
  /** which parts matched, e.g. ["postal_code", "street_number"] */
  parts: string[];
}

const DATA = () => process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const storeFile = () => path.join(DATA(), "protected.json");

export function loadProtected(): ProtectedEntry[] {
  if (!existsSync(storeFile())) return [];
  return (JSON.parse(readFileSync(storeFile(), "utf8")) as { entries: ProtectedEntry[] }).entries ?? [];
}

function saveProtected(entries: ProtectedEntry[]) {
  mkdirSync(DATA(), { recursive: true });
  writeFileSync(storeFile(), JSON.stringify({ entries }, null, 2) + "\n", { mode: 0o600 });
}

export function addProtected(kind: string, label: string, value: string): ProtectedEntry {
  if (!PROTECTED_KINDS.includes(kind as ProtectedKind)) throw new Error(`kind must be one of ${PROTECTED_KINDS.join(", ")}`);
  if (!/^[a-z0-9_-]{1,40}$/.test(label)) throw new Error("label: a-z, 0-9, _ or -, up to 40 characters");
  if (!value.trim()) throw new Error("value is empty");
  const entries = loadProtected();
  if (entries.some((e) => e.label === label)) throw new Error(`${label} is already registered; remove it first`);
  const entry: ProtectedEntry = { label, kind: kind as ProtectedKind, value: value.trim(), added_at: new Date().toISOString() };
  if (entry.kind === "address" && !addressParts(entry.value).street && !addressParts(entry.value).postal) {
    throw new Error("could not find a postal code or a street number (like 1-2-3 or 1丁目2番3号) in this address");
  }
  saveProtected([...entries, entry]);
  return entry;
}

export function removeProtected(label: string): boolean {
  const entries = loadProtected();
  const rest = entries.filter((e) => e.label !== label);
  if (rest.length === entries.length) return false;
  saveProtected(rest);
  return true;
}

/** For display: kind, label and a masked value (first and last character only). */
export function maskedProtected() {
  return loadProtected().map((e) => {
    const v = [...e.value];
    return { label: e.label, kind: e.kind, value: v.length <= 2 ? "**" : `${v[0]}${"*".repeat(Math.min(v.length - 2, 12))}${v[v.length - 1]}`, added_at: e.added_at };
  });
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一 -> 1, 十二 -> 12, 二十三 -> 23 (up to 99, enough for 丁目 and 番地). */
function kanjiNumber(s: string): string {
  if (!s.includes("十")) return [...s].map((c) => KANJI_DIGIT[c]).join("");
  const [tens, ones] = s.split("十");
  return String((tens ? KANJI_DIGIT[tens] : 1) * 10 + (ones ? KANJI_DIGIT[ones] : 0));
}

/**
 * Text as compared: NFKC (full-width -> half-width), lower case, dash variants -> "-",
 * kanji numerals -> digits, 1丁目2番3号 / 1番地2 / 1の2 -> 1-2-3, no whitespace or commas.
 * Registered values and messages go through the same function, so they meet in one form.
 */
export function normalize(s: string): string {
  let t = s.normalize("NFKC").toLowerCase();
  t = t.replace(/[〇一二三四五六七八九十]+(?=\s*(丁目|番地|番|号|の|-|‐))/g, kanjiNumber);
  t = t.replace(/[‐‑‒–—―−ｰー﹣⁃]/g, "-");
  t = t.replace(/〒/g, "");
  // connectors between numbers become hyphens; a trailing 号 / 番地 / 番 is dropped
  for (let i = 0; i < 3; i++) t = t.replace(/(\d)\s*(丁目|番地|番|号|の)\s*(?=\d)/g, "$1-");
  t = t.replace(/(\d)\s*(号|番地|番)/g, "$1");
  t = t.replace(/(\d)\s*-\s*(?=\d)/g, "$1-");
  return t.replace(/[\s,、，。]+/g, "");
}

const digits = (s: string) => s.replace(/\D/g, "");

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

interface AddressParts {
  full: string;
  postal?: string; // 7 digits
  street?: string; // e.g. "1-2-3"
  locality?: string; // e.g. "神宮前"
}

export function addressParts(value: string): AddressParts {
  const n = normalize(value);
  const pm = /(?<![\d-])(\d{3})-?(\d{4})(?![\d-])/.exec(n);
  const postal = pm ? pm[1] + pm[2] : undefined;
  const rest = pm ? n.slice(0, pm.index) + n.slice(pm.index + pm[0].length) : n;
  let street: string | undefined;
  let locality: string | undefined;
  for (const m of rest.matchAll(/(?<![\d-])\d{1,4}(?:-\d{1,4}){1,3}(?![\d-])/g)) {
    street = m[0];
    const before = rest.slice(0, m.index).replace(/[^\p{L}]+$/u, "");
    const lm = /([^都道府県市区町村郡]{2,12})$/u.exec(before);
    locality = lm ? lm[1] : undefined;
  }
  return { full: rest, postal, street, locality };
}

/** Number sequences in the text exactly as written, not glued to other digits. */
const tokensOf = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[0]);

function matchAddress(text: string, e: ProtectedEntry): string[] {
  const a = addressParts(e.value);
  const parts: string[] = [];
  if (a.full.length >= 6 && text.includes(a.full)) parts.push("full_address");
  if (a.postal && tokensOf(text, /(?<![\d-])\d{3}-?\d{4}(?![\d-])/g).some((t) => digits(t) === a.postal)) parts.push("postal_code");
  if (a.street) {
    const streets = tokensOf(text, /(?<![\d-])\d{1,4}(?:-\d{1,4}){1,3}(?![\d-])/g);
    if (streets.includes(a.street)) parts.push("street_number");
    else if (a.locality && text.includes(a.locality)) {
      // 神宮前1-2 (without the last number) next to the locality still pins the building.
      const prefix = a.street.split("-").slice(0, 2).join("-");
      if (a.street.split("-").length > 2 && streets.some((s) => s === prefix || s.startsWith(prefix + "-"))) parts.push("street_number_partial");
    }
  }
  // The neighbourhood alone is not a hit (the venue may be in the same area), but it is
  // reported next to a real hit.
  if (parts.length && a.locality && text.includes(a.locality)) parts.push("locality");
  return parts;
}

// ---------------------------------------------------------------------------
// phone numbers, email addresses, card numbers
// ---------------------------------------------------------------------------

/** National form: +81 90-1234-5678 / 81-90… / 090-1234-5678 -> 09012345678. */
function phoneNational(raw: string): string {
  const d = digits(raw);
  if (raw.trim().startsWith("+81") || (d.startsWith("81") && d.length >= 11 && d.length <= 12)) return "0" + d.slice(2);
  return d;
}

function phoneCandidates(text: string): string[] {
  return tokensOf(text, /\+?\d[\d\-().]{8,16}\d/g).map(phoneNational).filter((d) => d.length >= 10 && d.length <= 13);
}

const isJapanesePhone = (d: string) => /^0\d{9,10}$/.test(d);

function emailsIn(text: string): string[] {
  const t = text.replace(/[([]at[)\]]/g, "@").replace(/[([]dot[)\]]/g, ".");
  return tokensOf(t, /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g);
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

function cardNumbersIn(text: string): string[] {
  return tokensOf(text, /(?<!\d)\d(?:-?\d){12,18}(?!\d)/g)
    .map(digits)
    .filter((d) => d.length >= 13 && d.length <= 19 && luhn(d));
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

/**
 * Deterministic disclosure check of an outgoing message: the owner's registered values first,
 * then patterns for personal data that was never registered. No model is involved.
 */
export function detectDisclosure(message: string, entries = loadProtected()): Detection[] {
  // Phone numbers and card numbers are read before whitespace is removed, so "090 1234 5678"
  // and "4242 4242 4242 4242" are still seen as one number.
  const loose = message.normalize("NFKC").toLowerCase().replace(/[‐‑‒–—―−ｰー﹣⁃]/g, "-").replace(/(\d)[ 　]+(?=\d)/g, "$1-");
  const text = normalize(message);
  const out: Detection[] = [];
  const phones = phoneCandidates(loose);
  const emails = emailsIn(loose);
  const claimedPhones = new Set<string>();
  const claimedEmails = new Set<string>();

  for (const e of entries) {
    let parts: string[] = [];
    if (e.kind === "address") parts = matchAddress(text, e);
    else if (e.kind === "phone") {
      const want = phoneNational(e.value);
      if (phones.includes(want)) {
        parts = ["phone_number"];
        claimedPhones.add(want);
      }
    } else if (e.kind === "email") {
      const want = normalize(e.value);
      if (emails.includes(want)) {
        parts = ["email_address"];
        claimedEmails.add(want);
      }
    } else if (e.kind === "text") {
      const want = normalize(e.value);
      if (want.length >= 2 && text.includes(want)) parts = ["text"];
    }
    if (parts.length) out.push({ type: "disclose", source: "protected", field: `owner.${e.label}`, parts });
  }

  const otherPhones = phones.filter((p) => isJapanesePhone(p) && !claimedPhones.has(p));
  if (otherPhones.length) out.push({ type: "disclose", source: "pattern", field: "phone_number", parts: [`${otherPhones.length} found`] });
  const otherEmails = emails.filter((m) => !claimedEmails.has(m));
  if (otherEmails.length) out.push({ type: "disclose", source: "pattern", field: "email_address", parts: [`${otherEmails.length} found`] });
  const cards = cardNumbersIn(loose);
  if (cards.length) out.push({ type: "disclose", source: "pattern", field: "card_number", parts: [`${cards.length} found (Luhn valid)`] });
  return out;
}
