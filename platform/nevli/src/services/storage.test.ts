import { test } from "node:test";
import assert from "node:assert/strict";
import { appStorageKeys } from "./storage.ts";

const master = "11".repeat(32);

test("app storage keys are stable, per app, and in Garage's format", () => {
  const a = appStorageKeys(master, "locke");
  assert.deepEqual(a, appStorageKeys(master, "locke"));
  assert.equal(a.bucket, "app-locke");
  assert.match(a.accessKeyId, /^GK[0-9a-f]{24}$/);
  assert.match(a.secretAccessKey, /^[0-9a-f]{64}$/);
  const b = appStorageKeys(master, "pilot");
  assert.notEqual(a.accessKeyId, b.accessKeyId);
  assert.notEqual(a.secretAccessKey, b.secretAccessKey);
  assert.notEqual(appStorageKeys("22".repeat(32), "locke").secretAccessKey, a.secretAccessKey);
});
