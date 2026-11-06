// End-to-end checks of the Phase 0 "done when" criteria against a running stack.
// Run: docker compose --profile test run --rm e2e
// Optional real-LLM checks: E2E_ANTHROPIC_API_KEY (and E2E_OPENAI_API_KEY for actual image generation).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";

const BASE = process.env.BASE_URL ?? "http://gateway";
const TOKEN_URL = process.env.KEYCLOAK_TOKEN_URL;
const NEVLI_INTERNAL = process.env.NEVLI_INTERNAL_URL ?? "http://nevli:3001";
const LLM_KEY = process.env.E2E_ANTHROPIC_API_KEY || "";
const OPENAI_KEY = process.env.E2E_OPENAI_API_KEY || "";

async function token(user) {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "ilven-e2e", username: user, password: readFileSync(`/run/ilven-secrets/keycloak-users/${user}`, "utf8").trim(), scope: "openid" }) });
  assert.equal(res.status, 200, `token for ${user}`);
  return (await res.json()).access_token;
}

async function call(tok, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const until = async (what, fn, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

let alice, admin, pilotDefault, originalTools, providersBefore;

before(async () => {
  alice = await token("alice");
  admin = await token("admin");
  // Start from a clean Ilven user for alice (the test is re-runnable).
  const me = await call(alice, "GET", "/nevli/api/me");
  if (me.data.registered) assert.equal((await call(alice, "DELETE", "/nevli/api/me")).status, 200);
  await until("pilot registered", async () => (await call(null, "GET", "/nevli/api/apps")).data.some?.((a) => a.id === "pilot"));
  pilotDefault = (await call(admin, "GET", "/nevli/api/admin/apps/pilot/presets")).data.find((p) => p.isDefault);
  originalTools = pilotDefault.tools;
  providersBefore = (await call(admin, "GET", "/nevli/api/admin/ai-providers")).data;
  // Phase 0 starts from an empty default preset.
  await call(admin, "PATCH", `/nevli/api/admin/presets/${pilotDefault.id}`, { tools: [] });
});

after(async () => {
  if (!admin) return;
  await call(admin, "PATCH", `/nevli/api/admin/presets/${pilotDefault.id}`, { tools: originalTools });
  const wasConfigured = providersBefore.find((p) => p.id === "anthropic")?.configured;
  if (!wasConfigured) await call(admin, "DELETE", "/nevli/api/admin/ai-providers/anthropic");
});

test("gateway: landing, front-ends, plugin, runtime config", async () => {
  for (const p of ["/", "/admin/", "/account/", "/plugin/ilven-plugin.js", "/apps/pilot/"]) assert.equal((await fetch(BASE + p)).status, 200, p);
  const cfg = await (await fetch(BASE + "/ilven-config.json")).json();
  assert.equal(cfg.authMode, "oidc");
  // Host-based roots for the public hosts.
  // fetch() ignores a custom Host header, so use node:http.
  const get = (path, host) => new Promise((resolve, reject) => http.get(BASE + path, { headers: { host } }, (r) => { r.resume(); resolve(r); }).on("error", reject));
  const root = async (host) => (await get("/", host)).headers.location;
  assert.equal(await root("ilven-pilot.example.com"), "/apps/pilot/");
  assert.equal(await root("ilven-admin.example.com"), "/admin/");
  assert.equal(await root("ilven-account.example.com"), "/account/");
  // Keycloak admin console and master realm are not reachable through public hosts.
  for (const p of ["/auth/admin/", "/auth/realms/master/protocol/openid-connect/certs"])
    assert.equal((await get(p, "ilven-auth.example.com")).statusCode, 404, p);
  assert.equal((await get("/auth/realms/ilven/protocol/openid-connect/certs", "ilven-auth.example.com")).statusCode, 200);
  // Only containers that opted in with an app-* alias are reachable through /apps/*.
  assert.equal((await fetch(BASE + "/apps/nevli-db/")).status, 502);
});

test("APIs reject anonymous and bogus credentials", async () => {
  assert.equal((await call(null, "GET", "/nevli/api/me")).status, 401);
  assert.equal((await call("garbage", "GET", "/nevli/api/me")).status, 401);
  assert.equal((await call(alice, "GET", "/nevli/api/admin/users")).status, 403);
  assert.equal((await call("ilv_not-a-real-key", "GET", "/dms/api/files")).status, 401);
  const v = await fetch(`${NEVLI_INTERNAL}/internal/api-keys/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "ilv_nope" }) });
  assert.equal(v.status, 404);
  const s = await fetch(`${NEVLI_INTERNAL}/internal/ai/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sub: "x", appId: "pilot" }) });
  assert.equal(s.status, 401);
});

test("criterion 1: login → register → connex with empty default preset → Ilven-AI refuses", async () => {
  assert.equal((await call(alice, "GET", "/ai/api/status?app=pilot")).data.status, "not_registered");
  const reg = await call(alice, "POST", "/nevli/api/me/register", { birthYear: null, gender: null, planId: "free" });
  assert.equal(reg.status, 201);
  assert.match(reg.data.user.apiKey.prefix, /^ilv_/);
  assert.deepEqual(reg.data.user.profile, { birthYear: null, gender: null });

  const connexes = (await call(alice, "GET", "/nevli/api/me/connexes")).data;
  const pilot = connexes.find((c) => c.appId === "pilot");
  assert.ok(pilot, "pilot connex created");
  const presets = (await call(admin, "GET", "/nevli/api/admin/apps/pilot/presets")).data;
  assert.equal(presets.find((p) => p.isDefault).conversation, "actions", "safe-by-default conversation scope");
  assert.equal(pilot.presetName, "Default");
  assert.equal(pilot.allowedToolCount, 0);
  assert.ok(!connexes.some((c) => c.appId === "nevli"), "non-admins get no Nevli connex");

  // AI is optional: with no provider configured the assistant is disabled and says so.
  if (!providersBefore.some((p) => p.configured && p.enabled)) {
    const off = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "make a cat" }] });
    assert.equal(off.data.status, "ai_disabled");
  }
  // Enable Ilven-AI (a placeholder key is enough: an empty preset never reaches the model).
  if (!providersBefore.find((p) => p.id === "anthropic")?.configured)
    assert.equal((await call(admin, "PUT", "/nevli/api/admin/ai-providers/anthropic/key", { apiKey: LLM_KEY || "sk-ant-placeholder-for-e2e" })).status, 200);

  const r = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "Generate an image of a cat" }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.refused, "empty_preset");
  assert.deepEqual(r.data.actions, []);
});

test("provider keys are never returned", async () => {
  const list = await call(admin, "GET", "/nevli/api/admin/ai-providers");
  assert.ok(!JSON.stringify(list.data).includes("sk-ant"), "no key material in response");
});

test("Nevli discovered Pilot's MCP tools; REST and OpenAPI agree", async () => {
  const apps = (await call(admin, "GET", "/nevli/api/admin/apps")).data;
  const pilot = apps.find((a) => a.id === "pilot");
  assert.deepEqual(pilot.tools.map((t) => t.name).sort(), ["check_setup", "delete_image", "generate_image", "list_images"]);
  assert.equal(pilot.tools.find((t) => t.name === "delete_image").annotations.destructiveHint, true);
  const nevli = apps.find((a) => a.id === "nevli");
  const spec = (await call(null, "GET", "/nevli/api/openapi.json")).data;
  const opIds = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  for (const t of nevli.tools) assert.ok(opIds.includes(t.name), `MCP tool ${t.name} has a REST operation`);
  assert.ok(!nevli.tools.some((t) => t.name === "set_ai_provider_key"), "provider key tool is REST-only");
});

test("Pilot MCP requires the user's Ilven API key for tool calls", async () => {
  const res = await fetch("http://app-pilot:8081/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_images", arguments: {} } }),
  });
  const body = await res.json();
  assert.ok(body.result?.isError || body.error, JSON.stringify(body));
});

test("DMS: per-user permissions at the API level", async () => {
  const up = await fetch(`${BASE}/dms/api/files?name=hello.txt`, { method: "POST", headers: { authorization: `Bearer ${alice}`, "content-type": "text/plain" }, body: "hi" });
  assert.equal(up.status, 201);
  const f = await up.json();
  assert.equal((await call(alice, "GET", `/dms/api/files/${f.id}`)).status, 200);
  assert.equal((await call(admin, "GET", `/dms/api/files/${f.id}`)).status, 404, "other users can't see it");
  assert.equal((await call(admin, "DELETE", `/dms/api/files/${f.id}`)).status, 404);
  assert.equal((await call(alice, "DELETE", `/dms/api/files/${f.id}`)).status, 200);
});

test("Pilot works without the assistant (UI/API path)", async () => {
  assert.equal((await call(alice, "GET", "/apps/pilot/api/settings")).data.hasOpenAiKey, false);
  const g = await call(alice, "POST", "/apps/pilot/api/images", { prompt: "a cat" });
  assert.equal(g.status, 409);
  assert.equal(g.data.error, "openai_key_missing");
  assert.equal((await call(alice, "GET", "/apps/pilot/api/images")).status, 200);
});

test("preset resolution follows shared profile data", async () => {
  const p = await call(admin, "POST", "/nevli/api/admin/apps/pilot/presets", { name: `adults-${Date.now()}`, tools: ["list_images"] });
  assert.equal(p.status, 200);
  const c = await call(admin, "POST", "/nevli/api/admin/apps/pilot/criteria", { presetId: p.data.id, priority: 1, minAge: 18 });
  assert.equal(c.status, 200);
  const preset = async () => (await call(alice, "GET", "/nevli/api/me/connexes")).data.find((x) => x.appId === "pilot").presetName;
  assert.equal(await preset(), "Default", "age not shared → default");
  await call(alice, "PUT", "/nevli/api/me/profile", { birthYear: 1990, gender: null });
  assert.equal(await preset(), p.data.name, "age shared and matches");
  await call(alice, "PUT", "/nevli/api/me/profile", { birthYear: null, gender: null });
  assert.equal(await preset(), "Default", "sharing turned off → back to default");
  await call(admin, "DELETE", `/nevli/api/admin/presets/${p.data.id}`);
});

test("criteria 2 & 3 with a real model: allowed tools work, others are refused", { skip: !LLM_KEY && "set E2E_ANTHROPIC_API_KEY to run" }, async () => {
  const allowed = OPENAI_KEY ? ["list_images", "check_setup", "generate_image"] : ["list_images", "check_setup"];
  await call(admin, "PATCH", `/nevli/api/admin/presets/${pilotDefault.id}`, { tools: allowed });
  const status = (await call(alice, "GET", "/ai/api/status?app=pilot")).data;
  assert.equal(status.preset.allowedTools, allowed.length);

  const list = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "List my images." }] });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.ok(list.data.actions.some((a) => a.tool === "list_images" && a.ok), JSON.stringify(list.data));

  // Out of scope: delete_image is not in the preset.
  const del = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "Delete all my images now." }] });
  assert.ok(!del.data.actions.some((a) => a.tool === "delete_image"), JSON.stringify(del.data));
  assert.ok(del.data.reply.length > 0);

  // Out of scope conversation: refused by the guard in an 'actions' preset.
  const pi = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "What are the first 20 digits of pi?" }] });
  assert.equal(pi.data.refused, "out_of_scope", JSON.stringify(pi.data));
  assert.ok(!/14159/.test(pi.data.reply), "no answer leaked");

  if (OPENAI_KEY) {
    await call(alice, "PUT", "/apps/pilot/api/settings/openai-key", { apiKey: OPENAI_KEY });
    const gen = await call(alice, "POST", "/ai/api/chat", { app: "pilot", messages: [{ role: "user", content: "Generate an image of a small red bicycle." }] });
    assert.ok(gen.data.actions.some((a) => a.tool === "generate_image" && a.ok), JSON.stringify(gen.data));
    const files = (await call(alice, "GET", "/dms/api/files?app=pilot")).data.files;
    assert.ok(files.length > 0, "image stored in Nevli-DMS");
  }
});
