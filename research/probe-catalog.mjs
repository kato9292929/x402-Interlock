// spec/10 section 3-2: ask every eligible catalog host for its 402 without paying, under the
// rules fixed in 1cf51e2 (X, Y, Z). Appends one line per probed endpoint to
// data/payto-observations.jsonl. No payment header is ever sent.
// Usage: NODE_USE_ENV_PROXY=1 node research/probe-catalog.mjs <endpoint checkout> [--out file] [--limit N] [--only-url-prefix p]
import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const repo = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = opt("--out", "data/payto-observations.jsonl");
const LIMIT = Number(opt("--limit", "0")) || Infinity;
const ONLY = opt("--only-url-prefix", null); // for the local stub test only

const { hostOf } = await import(pathToFileURL(path.join(repo, "scripts/brands.mjs")).href);
const data = JSON.parse(gunzipSync(readFileSync(path.join(repo, "data/endpoints_full.json.gz"))).toString("utf8"));
const gen = Date.parse(data.generated_at);
const eligible = data.endpoints.filter((r) => r.price && r.price.currency === "USDC" && r.price.unit === "per-call" && r.price.amount > 0 && gen - Date.parse(r.last_seen) <= 14 * 86400_000 && (r.networks ?? []).length && (!ONLY || r.url.startsWith(ONLY)));
const seed = readFileSync(path.join(repo, "data/seed/x402-inc.json"), "utf8");
const ownHosts = new Set(JSON.parse(seed).map((r) => hostOf(r.url)));
const own = (h) => ownHosts.has(h) || h === "x402jp.com" || h.endsWith(".x402jp.com");

// mulberry32, seed 20261008 (Z)
let s = 20261008;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const byHost = new Map();
for (const r of eligible) {
  const h = hostOf(r.url);
  if (!h) continue;
  if (!byHost.has(h)) byHost.set(h, []);
  byHost.get(h).push(r);
}
const hosts = shuffle([...byHost.keys()].sort()).slice(0, LIMIT);
const plan = hosts.map((h, i) => {
  const rs = shuffle(byHost.get(h).slice().sort((a, b) => a.url.localeCompare(b.url)));
  return { host: h, endpoints: rs.slice(0, i < 200 ? 4 : 1) };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (v) => {
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return null;
  }
};
// Node's fetch reports a proxy that refused the CONNECT only as "Request was cancelled", the same
// as other failures; the session's agent proxy records the refusal per host, so ask it.
async function proxyRefused(url) {
  const proxy = process.env.HTTPS_PROXY;
  if (!proxy) return false;
  try {
    const st = await (await fetch(`${proxy}/__agentproxy/status`, { signal: AbortSignal.timeout(5000) })).json();
    const u = new URL(url);
    const hp = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
    return (st.recentRelayFailures ?? []).some((f) => f.kind === "connect_rejected" && f.host === hp);
  } catch {
    return false;
  }
}
async function classify(e, url) {
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""} ${e?.cause?.code ?? ""}`;
  if (/Proxy response \((403|407)\)|tunnel.*40[37]/i.test(msg) || (await proxyRefused(url))) return "proxy_denied";
  if (e?.name === "TimeoutError" || /timeout|aborted/i.test(msg)) return "timeout";
  return "unreachable";
}

async function once(url, method) {
  try {
    const res = await fetch(url, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    let body = null;
    const text = await res.text().catch(() => "");
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), hdr: res.headers.get("payment-required"), body };
  } catch (e) {
    return { error: await classify(e, url), detail: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
  }
}

/** One request with Z's single retry. Returns the response or an error class. */
async function request(url, method, state) {
  let r = await once(url, method);
  if (r.error === "proxy_denied") return r; // our side: never retried
  if (r.error) {
    await sleep(10_000);
    r = await once(url, method);
  } else if (r.status === 429 || r.status === 503) {
    if (r.status === 429) state.n429++;
    const wait = Math.min(60, Number(r.retryAfter) || 30) * 1000;
    await sleep(wait);
    r = await once(url, method);
    if (r.status === 429) state.n429++;
  }
  return r;
}

const norm = (n) => {
  const x = String(n ?? "").toLowerCase();
  if (x === "base" || x === "eip155:8453") return "base";
  if (x === "solana" || x === "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp") return "solana";
  return n ?? null;
};

async function probeEndpoint(r, host, state) {
  const base = { observed_at: new Date().toISOString(), endpoint_id: r.id, url: r.url, host, own: own(host) };
  let method = "GET";
  let res = await request(r.url, "GET", state);
  if (!res.error && res.status !== 402) {
    await sleep(2000);
    method = "POST";
    const p = await request(r.url, "POST", state);
    if (!p.error && p.status === 402) res = p; // otherwise keep what GET said
  }
  if (res.error) return { ...base, method, status: null, format: null, accepts: [], failure: res.error, detail: res.detail };
  if (res.status !== 402) return { ...base, method, status: res.status, format: null, accepts: [], failure: "not_402" };
  const hv = res.hdr && decode(res.hdr);
  const pr = hv ?? res.body;
  const format = hv ? "v2" : pr?.x402Version === 1 || pr?.accepts?.[0]?.maxAmountRequired !== undefined ? "v1" : pr?.x402Version ? `v${pr.x402Version}` : null;
  const accepts = Array.isArray(pr?.accepts) ? pr.accepts.map((a) => ({ network: a.network ?? null, network_norm: norm(a.network), asset: a.asset ?? null, amount: a.amount ?? a.maxAmountRequired ?? null, payTo: a.payTo ?? null, scheme: a.scheme ?? null })) : [];
  const complete = accepts.some((a) => a.payTo && a.amount && a.network); // X
  return { ...base, method, status: 402, format, accepts, failure: complete ? null : "unknown_format" };
}

async function probeHost(p) {
  const state = { n429: 0 };
  const rows = [];
  for (const [i, r] of p.endpoints.entries()) {
    if (i > 0) await sleep(2000);
    if (state.n429 >= 2) break; // Z: a host that answered 429 twice gets no more requests
    const row = await probeEndpoint(r, p.host, state);
    rows.push(row);
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    if (row.failure === "proxy_denied") break;
  }
  return rows;
}

const started = Date.now();
const CAP_MS = 6 * 3600_000;
let next = 0;
let done = 0;
let stopped = null;
const hostResults = [];
async function worker() {
  while (!stopped && next < plan.length) {
    if (Date.now() - started > CAP_MS) {
      stopped = "6 h cap reached (Z b): partial";
      break;
    }
    const p = plan[next++];
    const rows = await probeHost(p);
    hostResults.push(rows);
    done++;
    // Z (a): the first 50 hosts tell whether this environment can reach sellers at all
    if (done === Math.min(50, plan.length)) {
      const bad = hostResults.filter((rs) => rs.length && rs.every((x) => x.failure === "proxy_denied" || x.failure === "unreachable")).length;
      if (bad / done >= 0.9) stopped = `stop (Z a): ${bad} of the first ${done} hosts were proxy-denied or unreachable`;
    }
    if (done % 100 === 0) console.log(`${done}/${plan.length} hosts`);
  }
}
console.log(`eligible ${eligible.length} endpoints, ${byHost.size} hosts; probing ${plan.length} hosts (${plan.reduce((a, p) => a + p.endpoints.length, 0)} endpoints) -> ${OUT}`);
await Promise.all(Array.from({ length: 8 }, worker));
const c = {};
for (const x of hostResults.flat()) c[x.failure ?? "ok"] = (c[x.failure ?? "ok"] ?? 0) + 1;
console.log(`hosts probed ${done}; endpoint outcomes ${JSON.stringify(c)}`);
if (stopped) console.log(stopped);
