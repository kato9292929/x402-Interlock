import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { callJev, checkAnswer, clearJevCache } from "../lib/jev";

// A local stand-in for the TypeSafe API, shaped like the official SDK's contract.
let server: Server;
let reply: (body: { model: string; state: unknown; questions: Record<string, { type: string }> }) => { status: number; json?: unknown; delayMs?: number };
const seen: { path: string; auth: string; body: { model: string; state: unknown; questions: unknown } }[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url!, auth: String(req.headers.authorization), body });
      const r = reply(body);
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json ?? {}));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TYPESAFE_API_KEY = "test-key";
});
after(() => server.close());

const Q = {
  need: noul("Is it needed?"),
  kind: choice("Which kind?", { a: "A", b: "B" }),
  fit: score("How well?", ["poor", "ok", "good"]),
};
const good = {
  model: "jev-1.13.0",
  answers: {
    need: { type: "noul", noul: 0.8 },
    kind: { type: "choice", choice: "b", confidence: 0.6, probabilities: { a: 0.2, b: 0.8 } },
    fit: { type: "score", score: 1.4, confidence: 0.5, legend: { 0: "poor", 1: "ok", 2: "good" }, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 } },
  },
  usage: { input_tokens: 10, output_tokens: 3 },
};

test("request follows the SDK contract; the returned model string and answers come back as given", async () => {
  clearJevCache();
  reply = () => ({ status: 200, json: good });
  const r = await callJev({ task: { purpose: "x" } }, Q, { model: "jev-latest" });
  assert.equal(r.status, "OK");
  assert.equal(r.model, "jev-1.13.0");
  assert.equal((r.answers.need as { noul: number }).noul, 0.8);
  const last = seen.at(-1)!;
  assert.equal(last.path, "/v1/systemone");
  assert.equal(last.auth, "Bearer test-key");
  assert.equal(last.body.model, "jev-latest");
  assert.deepEqual(last.body.state, { task: { purpose: "x" } });
});

test("an answer that does not match its question is UNAVAILABLE", async () => {
  clearJevCache();
  reply = () => ({ status: 200, json: { ...good, answers: { ...good.answers, kind: { type: "choice", choice: "z", confidence: 0.9, probabilities: { z: 0.9 } } } } });
  const r = await callJev({}, Q);
  assert.equal(r.status, "UNAVAILABLE");
  assert.match((r as { reason: string }).reason, /answer kind: choice z/);
  reply = () => ({ status: 200, json: { answers: good.answers } }); // no model string
  assert.equal((await callJev({ n: 1 }, Q)).status, "UNAVAILABLE");
  assert.match(String(checkAnswer(Q.need, { type: "noul", noul: 1.5 })), /not a probability/);
});

test("an answer from a model other than the pinned one is UNAVAILABLE", async () => {
  clearJevCache();
  reply = () => ({ status: 200, json: good });
  const r = await callJev({ pin: 1 }, Q, { model: "jev-1.13.0", expectedModel: "jev-1.14.0" });
  assert.equal(r.status, "UNAVAILABLE");
  assert.match((r as { reason: string }).reason, /answered by jev-1\.13\.0, expected jev-1\.14\.0/);
  assert.equal((await callJev({ pin: 2 }, Q, { expectedModel: "jev-1.13.0" })).status, "OK");
});

test("HTTP errors retry once, then UNAVAILABLE; a timeout is UNAVAILABLE", async () => {
  clearJevCache();
  const before = seen.length;
  reply = () => ({ status: 503 });
  const r = await callJev({ n: 2 }, Q, { retries: 1 });
  assert.equal(r.status, "UNAVAILABLE");
  assert.equal(seen.length - before, 2);
  reply = () => ({ status: 200, json: good, delayMs: 1500 });
  const slow = await callJev({ n: 3 }, Q, { timeoutMs: 200, retries: 0 });
  assert.equal(slow.status, "UNAVAILABLE");
});

test("an HTTP error keeps the API's own explanation in the reason", async () => {
  clearJevCache();
  reply = () => ({ status: 422, json: { detail: "questions.fit.criteria.1: expected string" } });
  const r = await callJev({ e: 1 }, Q, { retries: 0 });
  assert.equal(r.status, "UNAVAILABLE");
  assert.match((r as { reason: string }).reason, /^HTTP 422: .*expected string/);
});

test("no API key -> UNAVAILABLE without a request", async () => {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const before = seen.length;
  try {
    const r = await callJev({}, Q);
    assert.equal(r.status, "UNAVAILABLE");
    assert.equal(seen.length, before);
  } finally {
    process.env.TYPESAFE_API_KEY = key;
  }
});

test("identical requests are served from the cache when enabled", async () => {
  clearJevCache();
  reply = () => ({ status: 200, json: good });
  const before = seen.length;
  await callJev({ same: true }, Q, { cacheMs: 60_000 });
  const again = await callJev({ same: true }, Q, { cacheMs: 60_000 });
  assert.equal(seen.length - before, 1);
  assert.equal(again.status === "OK" && again.cached, true);
});
