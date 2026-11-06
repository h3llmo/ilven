import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePresetId, type Criterion } from "./resolve.ts";

const c = (id: string, priority: number, x: Partial<Criterion>): Criterion => ({ id, presetId: `p-${id}`, priority, minAge: null, maxAge: null, gender: null, ...x });

test("no criteria → default", () => {
  assert.equal(resolvePresetId([], { age: 30 }, "default"), "default");
});

test("nothing shared → default even when criteria exist", () => {
  assert.equal(resolvePresetId([c("adult", 1, { minAge: 18 }), c("f", 2, { gender: "female" })], {}, "default"), "default");
});

test("first match by priority wins", () => {
  const cs = [c("b", 2, { minAge: 18 }), c("a", 1, { gender: "female" })];
  assert.equal(resolvePresetId(cs, { age: 40, gender: "female" }, "d"), "p-a");
  assert.equal(resolvePresetId(cs, { age: 40, gender: "male" }, "d"), "p-b");
});

test("age bounds are inclusive and require shared age", () => {
  const cs = [c("teen", 1, { minAge: 13, maxAge: 17 })];
  assert.equal(resolvePresetId(cs, { age: 17 }, "d"), "p-teen");
  assert.equal(resolvePresetId(cs, { age: 18 }, "d"), "d");
  assert.equal(resolvePresetId(cs, { gender: "male" }, "d"), "d");
});
