// spec/09: find (named-brand, first-party) pairs under the rules fixed before this search.
// Usage: node research/provenance-pairs.mjs <path to kato9292929/endpoint checkout>
// Uses that checkout's scripts/brands.mjs unchanged.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const { BRANDS, hostOf, firstPartyBrand, borrowedBrand, gatewayOf } = await import(pathToFileURL(path.join(repo, "scripts/brands.mjs")).href);
const data = JSON.parse(gunzipSync(readFileSync(path.join(repo, "data/endpoints_full.json.gz"))).toString("utf8"));
const gen = Date.parse(data.generated_at);
const labels = [...new Set(Object.values(BRANDS))];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = Object.fromEntries(labels.map((l) => [l, new RegExp(`(^|[^a-z0-9])${esc(l.toLowerCase())}([^a-z0-9]|$)`)]));

const eligible = data.endpoints.filter(
  (r) => r.price && r.price.currency === "USDC" && r.price.unit === "per-call" && r.price.amount > 0 && gen - Date.parse(r.last_seen) <= 14 * 86400_000 && (r.networks ?? []).length,
);
const fnKey = (url) => {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return (segs.at(-1) ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch {
    return "";
  }
};

const F = {}, R = {};
for (const r of eligible) {
  const host = hostOf(r.url);
  if (!host) continue;
  const fp = firstPartyBrand(host);
  if (fp) {
    (F[fp] ??= []).push(r);
    continue;
  }
  const text = `${r.name ?? ""} ${r.description ?? ""}`.toLowerCase();
  const named = new Set();
  const b = borrowedBrand(host);
  if (b) named.add(b);
  for (const l of labels) if (wordRe[l].test(text)) named.add(l);
  for (const l of named) (R[l] ??= []).push({ ...r, gateway: gatewayOf(host) });
}

const pairs = [], brandOnly = [];
for (const brand of Object.keys(F)) {
  for (const f of F[brand]) {
    for (const r of R[brand] ?? []) {
      const net = f.networks.filter((n) => r.networks.includes(n));
      if (!net.length || !(f.price.amount < r.price.amount)) continue;
      const row = { brand, net, f: { url: f.url, price: f.price.amount, name: f.name }, r: { url: r.url, price: r.price.amount, name: r.name, gateway: r.gateway }, key: fnKey(f.url) };
      (fnKey(f.url) && fnKey(f.url) === fnKey(r.url) ? pairs : brandOnly).push(row);
    }
  }
}
console.log(`eligible ${eligible.length} of ${data.endpoints.length}`);
console.log(`first-party brands: ${Object.entries(F).map(([b, x]) => `${b} ${x.length}`).join(", ") || "none"}`);
console.log(`named-brand listings for those brands: ${Object.keys(F).map((b) => `${b} ${(R[b] ?? []).length}`).join(", ")}`);
console.log(`candidate pairs (same function key, overlapping network, first party cheaper): ${pairs.length}`);
for (const p of pairs.slice(0, 60)) console.log(`  [${p.brand}] ${p.key} ${p.net.join("/")}  F ${p.f.price} ${p.f.url}\n      R ${p.r.price} ${p.r.url}${p.r.gateway ? `  (gateway ${p.r.gateway})` : ""}`);
console.log(`same brand, cheaper first party, different function (not counted): ${brandOnly.length}`);
