import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDisclosure, normalize, type ProtectedEntry } from "../lib/protect";

const E: ProtectedEntry[] = [
  { label: "home", kind: "address", value: "〒150-0001 東京都渋谷区神宮前1丁目2番3号", added_at: "" },
  { label: "mobile", kind: "phone", value: "090-1234-5678", added_at: "" },
  { label: "mail", kind: "email", value: "Kato@Example.com", added_at: "" },
];
const hit = (m: string) => detectDisclosure(m, E).map((d) => `${d.field}:${d.parts.join("+")}`);

test("normalize: full-width, dashes, kanji numerals and 丁目番号 meet in one form", () => {
  assert.equal(normalize("神宮前１－２－３"), "神宮前1-2-3");
  assert.equal(normalize("神宮前一丁目二番三号"), "神宮前1-2-3");
  assert.equal(normalize("神宮前1丁目2番地3"), "神宮前1-2-3");
  assert.equal(normalize("〒150ー0001"), "150-0001");
});

test("registered address: full, postal code, street number, partial street with locality", () => {
  assert.deepEqual(hit("〒150-0001 東京都渋谷区神宮前1丁目2番3号"), ["owner.home:full_address+postal_code+street_number+locality"]);
  assert.deepEqual(hit("住所は神宮前１－２－３です"), ["owner.home:street_number+locality"]);
  assert.deepEqual(hit("神宮前一丁目二番三号"), ["owner.home:street_number+locality"]);
  assert.deepEqual(hit("1500001 に送って"), ["owner.home:postal_code"]);
  assert.deepEqual(hit("Jingumae 1-2-3, Shibuya"), ["owner.home:street_number"]);
  assert.deepEqual(hit("神宮前1-2あたり"), ["owner.home:street_number_partial+locality"]);
});

test("registered phone and email in other spellings; unregistered ones by pattern", () => {
  assert.deepEqual(hit("電話 +81 90 1234 5678"), ["owner.mobile:phone_number"]);
  assert.deepEqual(hit("call 03-1111-2222"), ["phone_number:1 found"]);
  assert.deepEqual(hit("ｋａｔｏ＠ｅｘａｍｐｌｅ．ｃｏｍ"), ["owner.mail:email_address"]);
  assert.deepEqual(hit("mail kato(at)example.com or bob@test.org"), ["owner.mail:email_address", "email_address:1 found"]);
  assert.deepEqual(hit("card 4242 4242 4242 4242"), ["card_number:1 found (Luhn valid)"]);
  assert.deepEqual(hit("card 4242 4242 4242 4241"), []); // fails Luhn
});

test("ordinary text is not flagged: dates, prices, times, the neighbourhood alone", () => {
  assert.deepEqual(hit("Price is 1-2 USDC on 2026-10-13, see you at 18:00"), []);
  assert.deepEqual(hit("Meet at the station, room 302"), []);
  assert.deepEqual(hit("The venue is also in 神宮前"), []);
});
