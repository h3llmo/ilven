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
  for (const p of ["/", "/admin/", "/account/", "/plugin/ilven-plugin.js", "/apps/pilot/", "/apps/locke-vault/"]) assert.equal((await fetch(BASE + p)).status, 200, p);
  const cfg = await (await fetch(BASE + "/ilven-config.json")).json();
  assert.equal(cfg.authMode, "oidc");
  // Host-based roots for the public hosts.
  // fetch() ignores a custom Host header, so use node:http.
  const get = (path, host) => new Promise((resolve, reject) => http.get(BASE + path, { headers: { host } }, (r) => { r.resume(); resolve(r); }).on("error", reject));
  const root = async (host) => (await get("/", host)).headers.location;
  assert.equal(await root("ilven-pilot.example.com"), "/apps/pilot/");
  assert.equal(await root("ilven-admin.example.com"), "/admin/");
  assert.equal(await root("ilven-account.example.com"), "/account/");
  assert.equal(await root("locke-vault.example.com"), "/apps/locke-vault/", "integrated systems keep their own name");
  assert.equal(await root("localhost"), undefined, "no redirect for the local URL");
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

// ---------------- Locke-Vault ----------------
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG, Buffer.from("-v2")]); // still a PNG by its signature, different bytes
const V = "/apps/locke-vault/api";
const raw = (tok, method, path, bytes, type = "image/png") =>
  fetch(BASE + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": type }, body: bytes });
const bytesOf = async (tok, path) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, type: r.headers.get("content-type"), csp: r.headers.get("content-security-policy"), bytes: Buffer.from(await r.arrayBuffer()) };
};

test("object storage: Garage is private; apps get their bucket from Nevli with their app secret only", async () => {
  const storage = (body) => fetch(`${NEVLI_INTERNAL}/internal/apps/storage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await storage({ id: "locke-vault", secret: "x".repeat(40) })).status, 401, "wrong app secret");
  assert.equal((await storage({ id: "no-such-app", secret: "x".repeat(40) })).status, 401, "unknown app");
  assert.equal((await storage({ id: "nevli", secret: "x".repeat(40) })).status, 401, "platform apps get no storage");
  const adminApi = await fetch("http://garage:3903/v2/GetClusterStatus");
  assert.ok([401, 403].includes(adminApi.status), `Garage admin API without token: ${adminApi.status}`);
  const s3 = await fetch("http://garage:3900/");
  assert.ok([401, 403].includes(s3.status), `anonymous S3: ${s3.status}`);
});

test("delegated keys: issued only to a registered app with the user's live login; listed and revocable by the user", async () => {
  const internal = (path, body) => fetch(`${NEVLI_INTERNAL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const me = await call(alice, "GET", "/nevli/api/me");
  if (!me.data.registered) await call(alice, "POST", "/nevli/api/me/register", { birthYear: null, gender: null, planId: "free" });
  const issue = (b) => internal("/internal/apps/delegations", { id: "locke-vault", secret: "x".repeat(40), userToken: alice, audience: ["locke-vault"], purpose: "test", ...b });
  assert.equal((await issue({})).status, 401, "wrong app secret");
  assert.equal((await issue({ id: "no-such-app" })).status, 401, "unknown app");
  assert.equal((await internal("/internal/apps/delegations/revoke", { id: "locke-vault", secret: "x".repeat(40), sub: "x" })).status, 401);
  // Unknown keys are refused whatever the verifying service.
  assert.equal((await internal("/internal/api-keys/verify", { key: "ilv_" + "a".repeat(43), service: "locke-vault" })).status, 404);
  const list = await call(alice, "GET", "/nevli/api/me/delegations");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
  assert.equal((await call(alice, "DELETE", "/nevli/api/me/delegations/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await call(null, "GET", "/nevli/api/me/delegations")).status, 401);
});

test("vault: registered with Nevli, MCP tools discovered, viewer served, MCP needs an API key", async () => {
  await until("vault registered", async () => (await call(null, "GET", "/nevli/api/apps")).data.some?.((a) => a.id === "locke-vault"));
  const vault = (await call(admin, "GET", "/nevli/api/admin/apps")).data.find((a) => a.id === "locke-vault");
  assert.deepEqual(vault.tools.map((t) => t.name).sort(), ["get_staged", "list_sources", "list_staged", "save_to_documents", "search_source", "stage_from_source", "trash_staged", "trash_version"]);
  for (const t of ["trash_staged", "trash_version"]) assert.equal(vault.tools.find((x) => x.name === t).annotations.destructiveHint, true, t);
  const def = (await call(admin, "GET", "/nevli/api/admin/apps/locke-vault/presets")).data.find((p) => p.isDefault);
  assert.deepEqual(def.tools, [], "a new app's default preset is empty");
  assert.equal((await fetch(BASE + "/apps/locke-vault/")).status, 200);
  const res = await fetch("http://app-locke-vault:8081/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_staged", arguments: {} } }),
  });
  const body = await res.json();
  assert.ok(body.result?.isError || body.error, JSON.stringify(body));
});

test("vault: stage, version, isolation, push to DMS, trash, quota", async () => {
  assert.equal((await call(null, "GET", `${V}/items`)).status, 401);
  const q0 = (await call(alice, "GET", `${V}/quota`)).data;
  assert.equal(q0.limit, 256 * 1024 * 1024);

  // Only real images/PDF are accepted, whatever the declared type.
  assert.equal((await raw(alice, "POST", `${V}/items?title=x`, Buffer.from("<svg><script>alert(1)</script></svg>"), "image/svg+xml")).status, 415);
  assert.equal((await raw(alice, "POST", `${V}/items?title=x`, Buffer.from("<html>"), "image/png")).status, 415);

  const up = await raw(alice, "POST", `${V}/items?title=${encodeURIComponent("Beach day")}&app=locke`, PNG);
  assert.equal(up.status, 201);
  const item = await up.json();
  assert.equal(item.title, "Beach day");
  assert.equal(item.versions.length, 1);

  // A Locke transformation adds a version of the same item.
  const v2 = await raw(alice, "POST", `${V}/items/${item.id}/versions?app=locke&operation=face_swap&note=${encodeURIComponent("with Bob")}`, PNG2);
  assert.equal(v2.status, 201);
  const it2 = await v2.json();
  assert.deepEqual(it2.versions.map((v) => [v.n, v.parent, v.app, v.operation]), [[1, null, "locke", "upload"], [2, 1, "locke", "face_swap"]]);
  assert.equal(it2.currentVersion, 2);

  const c1 = await bytesOf(alice, `${V}/items/${item.id}/versions/1/content`);
  assert.equal(c1.status, 200);
  assert.ok(c1.bytes.equals(PNG), "v1 decrypts to the original bytes");
  assert.equal(c1.type, "image/png");
  assert.match(c1.csp, /sandbox/);
  assert.ok((await bytesOf(alice, `${V}/items/${item.id}/content`)).bytes.equals(PNG2), "latest is v2");

  const q1 = (await call(alice, "GET", `${V}/quota`)).data;
  assert.equal(q1.used - q0.used, PNG.length + PNG2.length, "quota counts every version");

  // Another user sees nothing and can't act on it.
  for (const [m, p] of [["GET", `/items/${item.id}`], ["GET", `/items/${item.id}/versions/1/content`], ["DELETE", `/items/${item.id}`], ["POST", `/items/${item.id}/push`], ["DELETE", `/items/${item.id}/versions/2`]])
    assert.equal((await call(admin, m, V + p, m === "POST" ? {} : undefined)).status, 404, `${m} ${p} as another user`);
  assert.equal((await raw(admin, "POST", `${V}/items/${item.id}/versions?app=x&operation=y`, PNG)).status, 404);
  assert.ok(!(await call(admin, "GET", `${V}/items`)).data.items.some((i) => i.id === item.id));

  // Save the chosen version to DMS: the item stays staged.
  const push = await call(alice, "POST", `${V}/items/${item.id}/push`, { version: 1 });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  const dmsFile = (await call(alice, "GET", `/dms/api/files/${push.data.dmsFileId}`)).data;
  assert.equal(dmsFile.appId, "locke-vault");
  assert.equal(dmsFile.metadata.vaultVersion, 1);
  assert.ok((await bytesOf(alice, `/dms/api/files/${push.data.dmsFileId}/content`)).bytes.equals(PNG));
  const after = (await call(alice, "GET", `${V}/items/${item.id}`)).data;
  assert.deepEqual(after.pushes.map((p) => p.version), [1]);

  // Trash one version, then the whole item; quota is freed, the DMS copy is kept.
  assert.equal((await call(alice, "DELETE", `${V}/items/${item.id}/versions/2`)).data.versions.length, 1);
  assert.equal((await call(alice, "DELETE", `${V}/items/${item.id}/versions/1`)).status, 400, "the only version can't be trashed alone");
  assert.equal((await call(alice, "DELETE", `${V}/items/${item.id}`)).status, 200);
  assert.equal((await call(alice, "GET", `${V}/items/${item.id}`)).status, 404);
  assert.equal((await call(alice, "GET", `${V}/quota`)).data.used, q0.used);
  assert.equal((await call(alice, "GET", `/dms/api/files/${push.data.dmsFileId}`)).status, 200);
  await call(alice, "DELETE", `/dms/api/files/${push.data.dmsFileId}`);
});

test("vault: read-only data sources (DMS built in, Pilot over the source contract)", async () => {
  // Seed: one plain DMS file and one "generated" Pilot image (stored the way Pilot stores them).
  const tag = `e2e${Date.now()}`;
  const d = await (await raw(alice, "POST", `/dms/api/files?name=${tag}-doc.png`, PNG)).json();
  const pRes = await fetch(`${BASE}/dms/api/files?app=pilot&name=gen.png`, { method: "POST", headers: { authorization: `Bearer ${alice}`, "content-type": "image/png", "x-dms-metadata": JSON.stringify({ prompt: `a ${tag} lighthouse` }) }, body: PNG2 });
  const p = await pRes.json();
  try {
    const list = (await call(alice, "GET", `${V}/sources`)).data.sources;
    // Built in and default sources; a deployment may add others (e.g. Locke from another repository).
    for (const id of ["dms", "icloud", "pilot"]) assert.equal(list.find((s) => s.id === id)?.available, true, `source ${id}`);

    const dq = await call(alice, "POST", `${V}/sources/dms/query`, { text: tag, limit: 10 });
    assert.equal(dq.status, 200, JSON.stringify(dq.data));
    assert.deepEqual(dq.data.items.map((i) => i.ref).sort(), [d.id, p.id].sort(), "DMS search matches names and metadata");
    const pq = await call(alice, "POST", `${V}/sources/pilot/query`, { text: tag, limit: 10 });
    assert.deepEqual(pq.data.items.map((i) => i.ref), [p.id]);
    assert.match(pq.data.items[0].description, /lighthouse/);
    assert.equal((await call(admin, "POST", `${V}/sources/pilot/query`, { text: tag, limit: 10 })).data.items.length, 0, "sources only return the caller's files");

    // Preview without staging, then stage from each source.
    assert.ok((await bytesOf(alice, `${V}/sources/pilot/items/${p.id}/content`)).bytes.equals(PNG2));
    const s1 = await call(alice, "POST", `${V}/items/from-source`, { source: "pilot", ref: p.id });
    assert.equal(s1.status, 201, JSON.stringify(s1.data));
    assert.deepEqual(s1.data.origin, { kind: "source", source: "pilot", ref: p.id, name: "gen.png" });
    assert.ok((await bytesOf(alice, `${V}/items/${s1.data.id}/content`)).bytes.equals(PNG2));
    const s2 = await call(alice, "POST", `${V}/items/from-source`, { source: "dms", ref: d.id, title: "From docs" });
    assert.equal(s2.data.title, "From docs");
    assert.equal((await call(admin, "POST", `${V}/items/from-source`, { source: "dms", ref: d.id })).status, 404, "can't stage another user's file");
    assert.equal((await call(alice, "POST", `${V}/sources/nope/query`, {})).status, 404);
    for (const s of [s1, s2]) await call(alice, "DELETE", `${V}/items/${s.data.id}`);
    // Sources are read-only: staging and trashing never changed them.
    assert.equal((await call(alice, "GET", `/dms/api/files/${p.id}`)).status, 200);
  } finally {
    await call(alice, "DELETE", `/dms/api/files/${d.id}`);
    await call(alice, "DELETE", `/dms/api/files/${p.id}`);
  }
});

test("vault: source collections and \"new since\" (workflows), rollback of the last step", async () => {
  const tag = `e2n${Date.now()}`;
  const up = async (app, name) => (await (await fetch(`${BASE}/dms/api/files?name=${tag}-${name}${app ? `&app=${app}` : ""}`, { method: "POST", headers: { authorization: `Bearer ${alice}`, "content-type": "image/png" }, body: PNG })).json());
  const a = await up("pilot", "a.png");
  const b = await up(null, "b.png");
  const c = await up("pilot", "c.png");
  try {
    // Collections: DMS offers one per app that saved files for this user.
    const dms = (await call(alice, "GET", `${V}/sources`)).data.sources.find((s) => s.id === "dms");
    assert.equal(dms.filters.collection, true);
    assert.equal(dms.filters.addedAfter, true);
    assert.ok(dms.collections.some((x) => x.id === "pilot"), JSON.stringify(dms.collections));
    const inPilot = await call(alice, "POST", `${V}/sources/dms/query`, { text: tag, collection: "pilot", limit: 10 });
    assert.deepEqual(inPilot.data.items.map((i) => i.ref).sort(), [a.id, c.id].sort());

    // New since: oldest first, strictly after, paged by cursor without repeats; Pilot supports it too.
    const seen = [];
    let cursor;
    do {
      const r = await call(alice, "POST", `${V}/sources/dms/query`, { text: tag, addedAfter: a.createdAt, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      seen.push(...r.data.items.map((i) => i.ref));
      assert.ok(r.data.items.every((i) => i.addedAt));
      cursor = r.data.cursor;
    } while (cursor && seen.length < 10);
    assert.deepEqual(seen, [b.id, c.id], "only files added after a, oldest first, no repeats");
    const pilotNew = await call(alice, "POST", `${V}/sources/pilot/query`, { text: tag, addedAfter: a.createdAt, limit: 10 });
    assert.deepEqual(pilotNew.data.items.map((i) => i.ref), [c.id]);
    assert.equal((await call(alice, "GET", `${V}/sources`)).data.sources.find((s) => s.id === "icloud").filters.addedAfter, false, "iCloud can't tell when a photo entered an album");

    // Workflow chain (enhance → face swap → background blur last); the user rolls back the last step.
    const item = (await (await raw(alice, "POST", `${V}/items?title=${tag}`, PNG)).json());
    for (const op of ["enhance", "face_swap", "background_blur"]) assert.equal((await raw(alice, "POST", `${V}/items/${item.id}/versions?app=locke&operation=${op}`, PNG2)).status, 201);
    const back = (await call(alice, "DELETE", `${V}/items/${item.id}/versions/4`)).data;
    assert.deepEqual(back.versions.map((v) => [v.n, v.operation]), [[1, "upload"], [2, "enhance"], [3, "face_swap"]]);
    assert.equal(back.currentVersion, 3);
    await call(alice, "DELETE", `${V}/items/${item.id}`);
  } finally {
    for (const f of [a, b, c]) await call(alice, "DELETE", `/dms/api/files/${f.id}`);
  }
});

test("vault: experimental iCloud source is off by default, per user, admin-approved, sidecar private", async () => {
  const X = `${V}/experimental/icloud`;
  // Clean slate for alice (re-runnable): an admin removes any previous request.
  for (const r of (await call(admin, "GET", `${V}/admin/experimental`)).data.icloud) if (r.user === "alice") await call(admin, "POST", `${V}/admin/experimental/${r.id}`, { status: "removed" });

  const src = (await call(alice, "GET", `${V}/sources`)).data.sources.find((s) => s.id === "icloud");
  assert.equal(src.experimental, true);
  assert.equal(src.status, "not_allowed");
  assert.equal((await call(alice, "POST", `${V}/sources/icloud/query`, {})).status, 403);
  assert.equal((await call(alice, "POST", `${X}/connect`, { appleId: "a@example.com", password: "x" })).status, 403);
  assert.equal((await call(alice, "PUT", `${X}/albums`, { collections: ["a:Locke"] })).status, 403);

  // Another user's access (the deployment's real admin may have enabled iCloud for themselves): must not change.
  const adminAccess = async () => (await call(admin, "GET", X)).data.access;
  const adminBefore = await adminAccess();

  // Request → only admins see and decide.
  assert.equal((await call(alice, "POST", `${X}/request-access`)).data.access, "requested");
  assert.equal((await call(alice, "GET", `${V}/admin/experimental`)).status, 403);
  const req = (await call(admin, "GET", `${V}/admin/experimental`)).data.icloud.find((r) => r.user === "alice");
  assert.equal(req.status, "requested");
  assert.equal((await call(alice, "POST", `${V}/admin/experimental/${req.id}`, { status: "granted" })).status, 403);
  assert.equal((await call(admin, "POST", `${V}/admin/experimental/${req.id}`, { status: "granted" })).status, 200);

  // Granted for alice only; another user's access is unchanged.
  const st = (await call(alice, "GET", X)).data;
  assert.equal(st.access, "granted");
  assert.equal(st.connection.state, "disconnected", "sidecar reachable from the vault, nothing connected yet");
  assert.equal(await adminAccess(), adminBefore, "granting alice doesn't change another user's access");
  await call(alice, "PUT", `${X}/albums`, { collections: [] });
  assert.equal((await call(alice, "POST", `${V}/sources/icloud/query`, {})).status, 409, "needs an album first");
  // Several albums, Favorites and Hidden: each a collection; nothing else can be read.
  assert.equal((await call(alice, "PUT", `${X}/albums`, { collections: ["nope"] })).status, 400);
  assert.deepEqual((await call(alice, "PUT", `${X}/albums`, { collections: ["a:Locke", "favorites", "hidden", "a:Upscale"] })).data.albums, ["a:Locke", "favorites", "hidden", "a:Upscale"]);
  const ic = (await call(alice, "GET", `${V}/sources`)).data.sources.find((s) => s.id === "icloud");
  assert.equal(ic.status, "needs_setup", "not connected yet");
  assert.equal(ic.filters.collection, true);
  assert.equal(ic.allCollections, false);
  assert.deepEqual(ic.collections, [{ id: "a:Locke", name: "Locke" }, { id: "favorites", name: "Favorites" }, { id: "hidden", name: "Hidden" }, { id: "a:Upscale", name: "Upscale" }]);
  assert.equal((await call(alice, "POST", `${V}/sources/icloud/query`, { collection: "a:Holidays" })).status, 404, "an album not chosen can't be read");
  assert.equal((await call(alice, "GET", `${V}/sources/icloud/items/${"c." + Buffer.from("a:Holidays").toString("base64url") + ".p1"}/content`)).status, 404, "nor a photo from it");
  const q = await call(alice, "POST", `${V}/sources/icloud/query`, {});
  assert.equal(q.status, 409);
  assert.equal(q.data.error, "not_connected");

  // The sidecar is not reachable from other containers.
  await assert.rejects(fetch("http://locke-vault-icloud:8000/healthz", { signal: AbortSignal.timeout(5000) }));

  // Revoke → off again.
  assert.equal((await call(admin, "POST", `${V}/admin/experimental/${req.id}`, { status: "revoked" })).status, 200);
  assert.equal((await call(alice, "POST", `${V}/sources/icloud/query`, {})).status, 403);
  assert.equal((await call(alice, "POST", `${X}/request-access`)).status, 403, "a revoked user can't re-request");
  await call(admin, "POST", `${V}/admin/experimental/${req.id}`, { status: "removed" });
});
