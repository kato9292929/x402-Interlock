// spec/10 section 3-3: count X (payTo, amount and network readable) and Y (the payTo of a host
// that names brand B against the payTo of B's own hosts) from data/payto-observations.jsonl,
// under the rules fixed in 1cf51e2. Facts only: no host is labelled a reseller or a wrapper.
// Usage: node research/payto-summary.mjs <endpoint checkout> [observations.jsonl]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, obsFile = "data/payto-observations.jsonl"] = process.argv.slice(2);
const { BRANDS, hostOf, firstPartyBrand, borrowedBrand } = await import(pathToFileURL(path.join(repo, "scripts/brands.mjs")).href);
const data = JSON.parse(gunzipSync(readFileSync(path.join(repo, "data/endpoints_full.json.gz"))).toString("utf8"));
const gen = Date.parse(data.generated_at);
const eligible = data.endpoints.filter((r) => r.price && r.price.currency === "USDC" && r.price.unit === "per-call" && r.price.amount > 0 && gen - Date.parse(r.last_seen) <= 14 * 86400_000 && (r.networks ?? []).length);
const DENOM = new Set(eligible.map((r) => hostOf(r.url)).filter(Boolean)).size;

// brands per host, as in spec/09 (adf7b29) but per host: F = own host of B, R = host naming B
const labels = [...new Set(Object.values(BRANDS))];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = labels.map((l) => [l, new RegExp(`(^|[^a-z0-9])${esc(l.toLowerCase())}([^a-z0-9]|$)`)]);
const F = new Map(); // brand -> Set(host)
const R = new Map(); // host -> Set(brand)
for (const r of eligible) {
  const h = hostOf(r.url);
  if (!h) continue;
  const fp = firstPartyBrand(h);
  if (fp) {
    if (!F.has(fp)) F.set(fp, new Set());
    F.get(fp).add(h);
    continue;
  }
  const named = new Set();
  const b = borrowedBrand(h);
  if (b) named.add(b);
  const text = `${r.name ?? ""} ${r.description ?? ""}`.toLowerCase();
  for (const [l, re] of wordRe) if (re.test(text)) named.add(l);
  if (named.size) {
    if (!R.has(h)) R.set(h, new Set());
    for (const n of named) R.get(h).add(n);
  }
}

const rows = readFileSync(obsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const addr = (a) => (a.network_norm === "solana" ? a.payTo : String(a.payTo).toLowerCase());
const pays = new Map(); // host -> Set("network|payTo")
const failures = new Map(); // host -> failure of its last row
const own = new Map();
for (const r of rows) {
  own.set(r.host, r.own);
  const ok = r.status === 402 && r.accepts.filter((a) => a.payTo && a.amount && a.network);
  if (ok && ok.length) {
    if (!pays.has(r.host)) pays.set(r.host, new Set());
    for (const a of ok) pays.get(r.host).add(`${a.network_norm}|${addr(a)}`);
  } else failures.set(r.host, r.failure);
}
const probed = new Set(rows.map((r) => r.host));
const readable = [...pays.keys()];
const nets = (h, n) => [...pays.get(h)].some((k) => k.startsWith(`${n}|`));
const why = {};
for (const h of probed) if (!pays.has(h)) why[failures.get(h)] = (why[failures.get(h)] ?? 0) + 1;

// Y
const P = new Map();
for (const [b, hs] of F) {
  const s = new Set();
  for (const h of hs) for (const k of pays.get(h) ?? []) s.add(k);
  P.set(b, s);
}
const pairs = [];
for (const [h, bs] of R) {
  for (const b of bs) {
    const p = P.get(b) ?? new Set();
    const mine = pays.get(h);
    const result = !p.size || !mine ? "unmatchable" : [...mine].some((k) => p.has(k)) ? "match" : "mismatch";
    pairs.push({ host: h, brand: b, result, own: own.get(h) ?? false });
  }
}
const hostResult = new Map();
for (const x of pairs) {
  const cur = hostResult.get(x.host);
  if (x.result === "mismatch" || cur === "mismatch") hostResult.set(x.host, "mismatch");
  else if (x.result === "match" || cur === "match") hostResult.set(x.host, "match");
  else hostResult.set(x.host, "unmatchable");
}
const cnt = (v) => [...hostResult.values()].filter((x) => x === v).length;

// same host, several endpoints (first 200 hosts): one payTo or several?
const multi = new Map();
for (const r of rows) {
  if (r.status !== 402) continue;
  if (!multi.has(r.host)) multi.set(r.host, []);
  multi.get(r.host).push(new Set(r.accepts.filter((a) => a.payTo).map((a) => `${a.network_norm}|${addr(a)}`)));
}
let same = 0;
let differ = 0;
for (const sets of multi.values()) {
  if (sets.length < 2) continue;
  const first = [...sets[0]].sort().join();
  if (sets.every((s) => [...s].sort().join() === first)) same++;
  else differ++;
}

// a payTo seen at two or more hosts (a fact, counted; gateways included)
const byPay = new Map();
for (const [h, ks] of pays) for (const k of ks) byPay.set(k, (byPay.get(k) ?? new Set()).add(h));
const shared = [...byPay.values()].filter((s) => s.size >= 2);

// W (spec/10, c856aae): readable hosts / distinct payTo. An EVM address on several EVM networks
// is one address; per network, hosts with a payTo on it / distinct payTo on it.
const isEvm = (k) => /^0x[0-9a-f]{40}$/i.test(k.split("|")[1]);
const addrKey = (k) => (isEvm(k) ? `evm|${k.split("|")[1]}` : k);
const hostsByAddr = new Map();
for (const [h, ks] of pays) for (const k of new Set([...ks].map(addrKey))) hostsByAddr.set(k, (hostsByAddr.get(k) ?? new Set()).add(h));
const W = readable.length && hostsByAddr.size ? readable.length / hostsByAddr.size : null;
const perNet = {};
for (const n of ["base", "solana", "other"]) {
  const inNet = (k) => (n === "other" ? !k.startsWith("base|") && !k.startsWith("solana|") : k.startsWith(`${n}|`));
  const hs = readable.filter((h) => [...pays.get(h)].some(inNet));
  const as = new Set(readable.flatMap((h) => [...pays.get(h)].filter(inNet)));
  perNet[n] = { hosts: hs.length, payTo: as.size, W: as.size ? +(hs.length / as.size).toFixed(2) : null };
}
const ranked = [...hostsByAddr.values()].sort((a, b) => b.size - a.size);
const top10Hosts = new Set(ranked.slice(0, 10).flatMap((s) => [...s]));
const brandShare = {};
for (const b of ["CoinGecko", "Exa"]) {
  const hs = [...R].filter(([h, bs]) => bs.has(b) && pays.has(h)).map(([h]) => h);
  const as = new Set(hs.flatMap((h) => [...pays.get(h)].map(addrKey)));
  brandShare[b] = { named_hosts: [...R].filter(([, bs]) => bs.has(b)).length, readable: hs.length, distinct_payTo: as.size };
}

const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`;
console.log(`denominator (eligible hosts)               ${DENOM}`);
console.log(`probed hosts                               ${probed.size}${probed.size < DENOM ? "  (run incomplete)" : ""}`);
console.log(`payTo readable (X)                         ${readable.length}  coverage ${pct(readable.length, DENOM)}  line 50%: ${readable.length / DENOM >= 0.5 ? "OVER" : "NOT OVER"}`);
console.log(`  with a Base payTo                        ${readable.filter((h) => nets(h, "base")).length}`);
console.log(`  with a Solana payTo                      ${readable.filter((h) => nets(h, "solana")).length}`);
console.log(`not readable, by reason                    ${JSON.stringify(why)}`);
console.log(`W hosts / distinct payTo (line 1.5)        ${W === null ? "-" : W.toFixed(2)}  ${W === null ? "" : W >= 1.5 ? "OVER" : "NOT OVER"}  (${readable.length} hosts, ${hostsByAddr.size} payTo)`);
console.log(`  per network                              ${JSON.stringify(perNet)}`);
console.log(`  hosts paid to the largest payTo          ${ranked[0]?.size ?? 0}`);
console.log(`  share of hosts paid to the top 10 payTo  ${readable.length ? pct(top10Hosts.size, readable.length) : "-"}`);
console.log(`  hosts naming CoinGecko / Exa             ${JSON.stringify(brandShare)}`);
console.log(`hosts naming a brand not their own          ${R.size} (readable ${[...R.keys()].filter((h) => pays.has(h)).length})`);
console.log(`  payTo matches the brand's own host       ${cnt("match")}`);
console.log(`  payTo differs from the brand's own host  ${cnt("mismatch")}`);
console.log(`  cannot be matched                        ${cnt("unmatchable")}`);
console.log(`brands with an own x402 host               ${[...F.keys()].join(", ")} (own payTo read: ${[...P].filter(([, s]) => s.size).map(([b]) => b).join(", ") || "none"})`);
console.log(`same host, several endpoints               one payTo ${same}, several ${differ}`);
console.log(`payTo seen at 2+ hosts                     ${shared.length} addresses over ${new Set(shared.flatMap((s) => [...s])).size} hosts`);
console.log(`hosts marked own (spec/10 section 4)       ${[...own].filter(([, v]) => v).length}`);
