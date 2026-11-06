import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { safeEqual, unauthorized } from "@ilven/common";
import { mountMcp, McpServer, toolResult } from "@ilven/common/mcp";
import type { Actor, Ctx } from "./context.ts";
import { mcpOps, requireAdmin } from "./ops.ts";
import { parseInput } from "./api.ts";
import { registerApp, type AppTool } from "./services/apps.ts";
import { unsealApiKey, verifyApiKey } from "./services/keys.ts";
import { activeProvider, aiEnabled } from "./services/providers.ts";
import { userBySub } from "./services/users.ts";
import { bearer } from "@ilven/common";

/** The Nevli tools as Nevli lists them on its own MCP server (used for self-registration). */
export function nevliTools(): AppTool[] {
  return mcpOps().map((o) => ({
    name: o.name,
    title: o.title,
    description: o.description,
    inputSchema: z.toJSONSchema(z.object(o.input)),
    annotations: { title: o.title, readOnlyHint: !!o.readOnly, destructiveHint: !!o.destructive },
  }));
}

/**
 * Internal API: reachable only on the compose network, never routed by the gateway.
 */
export function registerInternalApi(app: FastifyInstance, ctx: Ctx, internalToken: string) {
  const requireInternal = (h: unknown) => {
    if (typeof h !== "string" || !safeEqual(h, internalToken)) throw unauthorized("Internal token required");
  };

  // Apps and platform services verify an Ilven API key and learn which user it belongs to.
  app.post("/internal/api-keys/verify", async (req, reply) => {
    const { key } = z.object({ key: z.string().max(200) }).parse(req.body);
    const r = await verifyApiKey(ctx, key);
    if (!r) return reply.status(404).send({ error: "not_found", message: "Unknown or revoked key" });
    return { userId: r.userId, sub: r.sub };
  });

  // Integrations register themselves at startup. Re-registration requires the same app secret (TOFU).
  app.post("/internal/apps/register", async (req) => {
    const b = z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
        name: z.string().min(1).max(80),
        mcpUrl: z.url(),
        baseUrl: z.string().max(200).regex(/^\/apps\/[a-z0-9][a-z0-9-]{0,30}\/[\w\-./]*$/).optional(),
        secret: z.string().min(32).max(200),
      })
      .parse(req.body);
    // An app may only advertise a URL under its own gateway path.
    if (b.baseUrl && !b.baseUrl.startsWith(`/apps/${b.id}/`)) throw unauthorized("baseUrl must be under /apps/<id>/");
    if (b.id === "nevli") throw unauthorized("Reserved app id");
    await registerApp(ctx, { ...b, kind: "integration" });
    return { ok: true };
  });

  // Ilven-AI loads the connex of (user, app). This is the only place a user's API key or a provider key is unsealed.
  app.post("/internal/ai/session", async (req) => {
    requireInternal(req.headers["x-ilven-internal-token"]);
    const { sub, appId, peek } = z.object({ sub: z.string().min(1), appId: z.string().min(1), peek: z.boolean().default(false) }).parse(req.body);
    const user = await userBySub(ctx, sub);
    if (!user) return { status: "not_registered" };
    const { rows } = await ctx.db.query<{ app_name: string; mcp_url: string; api_key_id: string | null; preset_id: string | null; preset_name: string | null; tools: string[] | null; rules: string | null }>(
      `SELECT a.name AS app_name, a.mcp_url, c.api_key_id, p.id AS preset_id, p.name AS preset_name, p.tools, p.rules
       FROM connexes c JOIN apps a ON a.id = c.app_id LEFT JOIN presets p ON p.id = c.preset_id
       WHERE c.user_id = $1 AND c.app_id = $2`,
      [user.id, appId],
    );
    const c = rows[0];
    if (!c) return { status: "no_connex" };
    const tools = c.tools ?? [];
    // peek: status only, nothing is unsealed.
    if (peek) {
      if (!(await aiEnabled(ctx))) return { status: "ai_disabled" };
      return { status: "ok", app: { id: appId, name: c.app_name }, preset: { id: c.preset_id, name: c.preset_name ?? "Default", tools, rules: "" } };
    }
    const provider = await activeProvider(ctx);
    if (!provider) return { status: "ai_disabled" };
    // Data minimisation: the user's API key is only released when the preset allows at least one tool.
    const apiKey = tools.length && c.api_key_id ? await unsealApiKey(ctx, c.api_key_id) : null;
    if (tools.length && !apiKey) return { status: "no_api_key" };
    return {
      status: "ok",
      app: { id: appId, name: c.app_name },
      preset: { id: c.preset_id, name: c.preset_name ?? "Default", tools, rules: c.rules ?? "" },
      mcpUrl: c.mcp_url,
      apiKey,
      provider,
    };
  });

  // Nevli's own MCP server. Listing is open on the internal network (discovery); every call needs an admin's API key.
  mountMcp(app, "/mcp", async (req) => {
    const key = bearer(req);
    const caller = key ? await verifyApiKey(ctx, key) : null;
    const server = new McpServer({ name: "nevli", version: "0.1.0" });
    for (const o of mcpOps()) {
      server.registerTool(
        o.name,
        { title: o.title, description: o.description, inputSchema: o.input, annotations: { title: o.title, readOnlyHint: !!o.readOnly, destructiveHint: !!o.destructive } },
        (async (args: unknown) =>
          toolResult(async () => {
            if (!caller) throw unauthorized("An Ilven API key is required");
            const actor: Actor = { sub: caller.sub, isAdmin: caller.isAdmin, via: "mcp" };
            requireAdmin(actor);
            return o.run(ctx, parseInput(o, args ?? {}), actor);
          })) as never,
      );
    }
    return server;
  });
}
