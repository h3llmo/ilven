import { notFound } from "@ilven/common";
import type { Ctx } from "../context.ts";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
  google: "gemini-2.5-pro",
};

/** Lists configured providers. The key itself is never returned (§6). */
export async function listProviders(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ id: ProviderId; model: string; enabled: boolean; priority: number; updated_at: Date }>(
    "SELECT id, model, enabled, priority, updated_at FROM ai_providers ORDER BY priority, id",
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return PROVIDERS.map((id) => {
    const r = byId.get(id);
    return r
      ? { id, configured: true, model: r.model, enabled: r.enabled, priority: r.priority, updatedAt: r.updated_at }
      : { id, configured: false, model: DEFAULT_MODELS[id], enabled: false, priority: null, updatedAt: null };
  });
}

export async function setProviderKey(ctx: Ctx, id: ProviderId, apiKey: string, model?: string) {
  await ctx.db.query(
    `INSERT INTO ai_providers (id, sealed_key, model) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET sealed_key = EXCLUDED.sealed_key, model = COALESCE($4, ai_providers.model), updated_at = now()`,
    [id, ctx.sealer.seal(apiKey), model ?? DEFAULT_MODELS[id], model ?? null],
  );
}

export async function updateProvider(ctx: Ctx, id: ProviderId, p: { model?: string; enabled?: boolean; priority?: number }) {
  const r = await ctx.db.query(
    `UPDATE ai_providers SET model = COALESCE($2, model), enabled = COALESCE($3, enabled), priority = COALESCE($4, priority), updated_at = now() WHERE id = $1`,
    [id, p.model ?? null, p.enabled ?? null, p.priority ?? null],
  );
  if (!r.rowCount) throw notFound("Provider not configured; set its key first");
}

export async function deleteProvider(ctx: Ctx, id: ProviderId) {
  await ctx.db.query("DELETE FROM ai_providers WHERE id = $1", [id]);
}

/** The provider Ilven-AI should use, with its key unsealed. Internal use only. */
export async function activeProvider(ctx: Ctx): Promise<{ id: ProviderId; model: string; apiKey: string } | null> {
  const { rows } = await ctx.db.query<{ id: ProviderId; model: string; sealed_key: string }>(
    "SELECT id, model, sealed_key FROM ai_providers WHERE enabled ORDER BY priority, id LIMIT 1",
  );
  return rows[0] ? { id: rows[0].id, model: rows[0].model, apiKey: ctx.sealer.open(rows[0].sealed_key) } : null;
}

export async function aiEnabled(ctx: Ctx): Promise<boolean> {
  const { rows } = await ctx.db.query("SELECT 1 FROM ai_providers WHERE enabled LIMIT 1");
  return rows.length > 0;
}
