// spec/09-3: draw the 100-host sample under the rules fixed in ad1a960 and estimate what buying
// each chosen endpoint once would cost. Usage: node research/observe-sample.mjs <endpoint checkout>
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const { BRANDS, hostOf, firstPartyBrand, borrowedBrand } = await import(pathToFileURL(path.join(repo, "scripts/brands.mjs")).href);
const data = JSON.parse(gunzipSync(readFileSync(path.join(repo, "data/endpoints_full.json.gz"))).toString("utf8"));
const rank = JSON.parse(readFileSync(path.join(repo, "data/rank.json"), "utf8"));
const gen = Date.parse(data.generated_at);
const eligible = data.endpoints.filter((r) => r.price && r.price.currency === "USDC" && r.price.unit === "per-call" && r.price.amount > 0 && gen - Date.parse(r.last_seen) <= 14 * 86400_000 && (r.networks ?? []).length);

// the same "names a brand" test as research/provenance-pairs.mjs (spec/09)
const labels = [...new Set(Object.values(BRANDS))];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = labels.map((l) => new RegExp(`(^|[^a-z0-9])${esc(l.toLowerCase())}([^a-z0-9]|$)`));
const brandish = (r, host) => !!firstPartyBrand(host) || !!borrowedBrand(host) || wordRe.some((re) => re.test(`${r.name ?? ""} ${r.description ?? ""}`.toLowerCase()));

const byHost = new Map();
for (const r of eligible) {
  const h = hostOf(r.url);
  if (!h) continue;
  if (!byHost.has(h)) byHost.set(h, []);
  byHost.get(h).push(r);
}
const top = new Set(rank.rows.map((x) => x.host));
const strata = { B: [], H: [], M: [], L: [] };
for (const [h, rs] of byHost) {
  if (rs.some((r) => brandish(r, h))) strata.B.push(h);
  else if (top.has(h)) strata.H.push(h);
  else if (rs.some((r) => r.popularity !== undefined)) strata.M.push(h);
  else strata.L.push(h);
}
for (const k of Object.keys(strata)) strata[k].sort();

// mulberry32, seed 20261008
let s = 20261008;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

const chosen = { B: strata.B };
const rest = 100 - strata.B.length;
const each = Math.floor(rest / 3);
chosen.H = pick(strata.H, Math.min(each, strata.H.length));
chosen.M = pick(strata.M, Math.min(each, strata.M.length));
chosen.L = pick(strata.L, 100 - strata.B.length - chosen.H.length - chosen.M.length);

const sample = [];
for (const [k, hosts] of Object.entries(chosen)) for (const h of hosts) {
  const rs = byHost.get(h).slice().sort((a, b) => a.url.localeCompare(b.url));
  const r = rs[Math.floor(rnd() * rs.length)];
  sample.push({ stratum: k, host: h, url: r.url, price: r.price.amount, networks: r.networks });
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const prices = sample.map((x) => x.price).sort((a, b) => a - b);
console.log(`eligible records ${eligible.length}, hosts ${byHost.size}`);
console.log(`strata (hosts): B ${strata.B.length}, H ${strata.H.length}, M ${strata.M.length}, L ${strata.L.length}`);
console.log(`sample: ${sample.length} hosts (B ${chosen.B.length}, H ${chosen.H.length}, M ${chosen.M.length}, L ${chosen.L.length})`);
console.log(`cost of buying each once: ${sum(prices).toFixed(4)} USDC (median ${prices[Math.floor(prices.length / 2)]}, max ${prices.at(-1)})`);
for (const k of Object.keys(chosen)) console.log(`  ${k}: ${sum(sample.filter((x) => x.stratum === k).map((x) => x.price)).toFixed(4)} USDC`);
const only = (n) => sample.filter((x) => x.networks.length === 1 && x.networks[0] === n);
console.log(`networks: Base only ${only("Base").length} (${sum(only("Base").map((x) => x.price)).toFixed(4)} USDC), Solana only ${only("Solana").length} (${sum(only("Solana").map((x) => x.price)).toFixed(4)} USDC), both ${sample.filter((x) => x.networks.length > 1).length}`);
console.log(`five most expensive: ${sample.slice().sort((a, b) => b.price - a.price).slice(0, 5).map((x) => `${x.host} ${x.price}`).join(", ")}`);
writeFileSync("research/results/observe-sample-20261008.json", JSON.stringify({ rules_commit: "ad1a960", data_commit: "83e33d7", sample }, null, 2) + "\n");
