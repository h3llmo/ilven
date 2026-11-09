import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAudience } from "./delegations.ts";

test("delegated key audience: named services only, never the control plane or the assistant", () => {
  assert.equal(checkAudience(["locke-vault", "dms", "locke"]), null);
  assert.match(checkAudience([]) ?? "", /empty/);
  assert.match(checkAudience(["nevli"]) ?? "", /can't/);
  assert.match(checkAudience(["locke", "ilven-ai"]) ?? "", /can't/);
  assert.match(checkAudience(["Locke Vault"]) ?? "", /invalid/);
});
