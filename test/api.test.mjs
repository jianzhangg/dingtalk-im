import test from "node:test";
import assert from "node:assert/strict";
import { fmtTime, checkId, checkText, assertAllowed } from "../server/dws.mjs";

test("fmtTime default is 7d ago shape", () => {
  assert.match(fmtTime(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("allowlist blocks raw passthrough", () => {
  assert.throws(() => assertAllowed("chat", "rm -rf"), /not allowlisted/);
  assert.doesNotThrow(() => assertAllowed("chat", "+messages-send"));
});

test("input validation", () => {
  assert.equal(checkText("hi"), "hi");
  assert.throws(() => checkText(""), /invalid text/);
  assert.throws(() => checkId("a;b"), /invalid id/);
  assert.equal(checkId("cid2d3j4Wii9TQqYUcybedKXg=="), "cid2d3j4Wii9TQqYUcybedKXg==");
});
