import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { conflict, hmacHex, notFound, safeEqual } from "@ilven/common";
import type { Ctx } from "../context.ts";
import { syncConnexes } from "./connexes.ts";

export interface AppTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
}

export interface RegisterApp {
  id: string;
  name: string;
  kind: "platform" | "integration";
  mcpUrl: string;
  baseUrl?: string;
  secret?: string;
}

/**
 * Registers (or re-registers) an Ilven-App. Integrations authenticate re-registration with the secret
 * they presented the first time (trust on first use). A new app always starts with an EMPTY default preset,
 * so registering an app grants Ilven-AI nothing until an admin allows tools (§2.8).
 */
export async function registerApp(ctx: Ctx, a: RegisterApp, localTools?: AppTool[]) {
  const secretHash = a.secret ? hmacHex(ctx.masterKey, "ilven/app-secret", a.secret) : null;
  const existing = await ctx.db.query<{ secret_hash: string | null; kind: string }>("SELECT secret_hash, kind FROM apps WHERE id = $1", [a.id]);
  const row = existing.rows[0];
  if (row) {
    if (row.kind !== a.kind) throw conflict("App id already used by another kind of app");
    if (row.secret_hash && (!secretHash || !safeEqual(row.secret_hash, secretHash))) throw conflict("App id already registered with a different secret");
    await ctx.db.query("UPDATE apps SET name = $2, mcp_url = $3, base_url = $4, updated_at = now() WHERE id = $1", [a.id, a.name, a.mcpUrl, a.baseUrl ?? null]);
  } else {
    await ctx.db.query(
      "INSERT INTO apps (id, name, kind, mcp_url, base_url, secret_hash) VALUES ($1, $2, $3, $4, $5, $6)",
      [a.id, a.name, a.kind, a.mcpUrl, a.baseUrl ?? null, secretHash],
    );
  }
  await ctx.db.query(
    "INSERT INTO presets (app_id, name, is_default, tools, rules) VALUES ($1, 'Default', true, '{}', '') ON CONFLICT DO NOTHING",
    [a.id],
  );
  if (localTools) await storeTools(ctx, a.id, localTools, null);
  else await refreshTools(ctx, a.id).catch(() => {});
  await syncConnexes(ctx, { appId: a.id });
}

/** Discovers the app's tools by listing them from its MCP server (no user credential is sent). */
export async function refreshTools(ctx: Ctx, appId: string): Promise<AppTool[]> {
  const { rows } = await ctx.db.query<{ mcp_url: string; kind: string }>("SELECT mcp_url, kind FROM apps WHERE id = $1", [appId]);
  if (!rows[0]) throw notFound("App not found");
  try {
    const tools = await listRemoteTools(rows[0].mcp_url);
    await storeTools(ctx, appId, tools, null);
    return tools;
  } catch (e) {
    await ctx.db.query("UPDATE apps SET tools_error = $2 WHERE id = $1", [appId, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}

async function storeTools(ctx: Ctx, appId: string, tools: AppTool[], err: string | null) {
  await ctx.db.query("UPDATE apps SET tools = $2, tools_refreshed_at = now(), tools_error = $3 WHERE id = $1", [appId, JSON.stringify(tools), err]);
}

export async function listRemoteTools(mcpUrl: string): Promise<AppTool[]> {
  const client = new Client({ name: "nevli-discovery", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const out: AppTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) out.push({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listApps(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `SELECT id, name, kind, mcp_url AS "mcpUrl", base_url AS "baseUrl", tools, tools_refreshed_at AS "toolsRefreshedAt",
            tools_error AS "toolsError", registered_at AS "registeredAt" FROM apps ORDER BY kind DESC, id`,
  );
  return rows;
}

/** True when `secret` is the app secret the integration registered with (integrations only). */
export async function verifyAppSecret(ctx: Ctx, appId: string, secret: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ secret_hash: string | null }>("SELECT secret_hash FROM apps WHERE id = $1 AND kind = 'integration'", [appId]);
  const stored = rows[0]?.secret_hash;
  return !!stored && safeEqual(stored, hmacHex(ctx.masterKey, "ilven/app-secret", secret));
}
