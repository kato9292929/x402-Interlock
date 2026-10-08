// spec/09-2 / 09-3: ask each URL for its 402 without paying, and record what it says:
// status, x402 version, and every accepts entry (network, asset, amount, payTo). No payment
// header is ever sent. Usage: node research/probe-402.mjs <urls.txt | sample.json> [out.json]
import { readFileSync, writeFileSync } from "node:fs";

const [input, out = "research/results/probe-402.json"] = process.argv.slice(2);
const text = readFileSync(input, "utf8");
const urls = input.endsWith(".json") ? JSON.parse(text).sample.map((x) => x.url) : text.split(/\s+/).filter(Boolean);

function decodeHeader(v) {
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function probe(url) {
  const at = new Date().toISOString();
  for (const method of ["GET", "POST"]) {
    try {
      const res = await fetch(url, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(15_000), redirect: "manual" });
      if (res.status !== 402 && method === "GET") continue; // some sellers only answer POST
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not JSON */
      }
      // v2 sends PAYMENT-REQUIRED as a base64 header; v1 sends the requirements in the body
      const hdr = res.headers.get("payment-required");
      const pr = (hdr && decodeHeader(hdr)) || body;
      const accepts = Array.isArray(pr?.accepts) ? pr.accepts.map((a) => ({ network: a.network ?? null, asset: a.asset ?? null, amount: a.amount ?? a.maxAmountRequired ?? null, payTo: a.payTo ?? null, scheme: a.scheme ?? null })) : [];
      return { url, at, method, status: res.status, x402Version: pr?.x402Version ?? null, accepts };
    } catch (e) {
      if (method === "POST") return { url, at, method, status: null, error: String(e.cause?.code ?? e.name ?? e) };
    }
  }
  return { url, at, method: "POST", status: null, error: "no answer" };
}

const rows = [];
for (const u of urls) {
  const r = await probe(u);
  rows.push(r);
  console.log(`${String(r.status ?? "ERR").padEnd(4)} ${r.accepts?.map((a) => `${a.network}:${a.payTo}`).join(" ") ?? r.error}  ${u}`);
}
const n402 = rows.filter((r) => r.status === 402).length;
console.log(`\n${n402} of ${rows.length} answered 402; ${rows.filter((r) => r.status === null).length} did not answer`);
writeFileSync(out, JSON.stringify({ probed_at: new Date().toISOString(), rows }, null, 2) + "\n");
