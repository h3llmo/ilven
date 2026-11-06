import type { Ctx, Gender } from "../context.ts";
import { ageFromBirthYear, resolvePresetId, type Criterion } from "./resolve.ts";

interface UserRow { id: string; is_admin: boolean; birth_year: number | null; gender: Gender | null; api_key_id: string }
interface AppRow { id: string; kind: "platform" | "integration" }

/**
 * Brings connexes in line with users, apps, profiles, presets and criteria.
 * One connex per (user with an active API key) × (Ilven-App). Platform apps (Nevli itself) only get connexes for admins.
 * Called after any change that can affect resolution (§4.2).
 */
export async function syncConnexes(ctx: Ctx, scope: { userId?: string; appId?: string } = {}) {
  const users = (
    await ctx.db.query<UserRow>(
      `SELECT u.id, u.is_admin, u.birth_year, u.gender, k.id AS api_key_id
       FROM users u JOIN api_keys k ON k.user_id = u.id AND k.revoked_at IS NULL
       WHERE ($1::uuid IS NULL OR u.id = $1)`,
      [scope.userId ?? null],
    )
  ).rows;
  const apps = (await ctx.db.query<AppRow>("SELECT id, kind FROM apps WHERE ($1::text IS NULL OR id = $1)", [scope.appId ?? null])).rows;

  for (const app of apps) {
    const def = await ctx.db.query<{ id: string }>("SELECT id FROM presets WHERE app_id = $1 AND is_default", [app.id]);
    if (!def.rows[0]) continue;
    const criteria = (
      await ctx.db.query<{ id: string; preset_id: string; priority: number; min_age: number | null; max_age: number | null; gender: Gender | null }>(
        "SELECT id, preset_id, priority, min_age, max_age, gender FROM preset_criteria WHERE app_id = $1",
        [app.id],
      )
    ).rows.map<Criterion>((r) => ({ id: r.id, presetId: r.preset_id, priority: r.priority, minAge: r.min_age, maxAge: r.max_age, gender: r.gender }));

    for (const u of users) {
      const eligible = app.kind === "integration" || u.is_admin;
      if (!eligible) {
        await ctx.db.query("DELETE FROM connexes WHERE user_id = $1 AND app_id = $2", [u.id, app.id]);
        continue;
      }
      const presetId = resolvePresetId(criteria, { age: ageFromBirthYear(u.birth_year), gender: u.gender ?? undefined }, def.rows[0].id);
      await ctx.db.query(
        `INSERT INTO connexes (user_id, app_id, preset_id, api_key_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, app_id) DO UPDATE SET preset_id = EXCLUDED.preset_id, api_key_id = EXCLUDED.api_key_id,
           updated_at = CASE WHEN connexes.preset_id IS DISTINCT FROM EXCLUDED.preset_id OR connexes.api_key_id IS DISTINCT FROM EXCLUDED.api_key_id THEN now() ELSE connexes.updated_at END`,
        [u.id, app.id, presetId, u.api_key_id],
      );
    }
  }
}

export async function listConnexes(ctx: Ctx, f: { userId?: string; appId?: string; sub?: string }) {
  const { rows } = await ctx.db.query(
    `SELECT c.id, c.user_id AS "userId", u.sub, c.app_id AS "appId", a.name AS "appName",
            c.preset_id AS "presetId", p.name AS "presetName", COALESCE(array_length(p.tools, 1), 0) AS "allowedToolCount",
            (c.api_key_id IS NOT NULL) AS "hasApiKey", c.updated_at AS "updatedAt"
     FROM connexes c JOIN users u ON u.id = c.user_id JOIN apps a ON a.id = c.app_id LEFT JOIN presets p ON p.id = c.preset_id
     WHERE ($1::uuid IS NULL OR c.user_id = $1) AND ($2::text IS NULL OR c.app_id = $2) AND ($3::text IS NULL OR u.sub = $3)
     ORDER BY u.sub, a.id`,
    [f.userId ?? null, f.appId ?? null, f.sub ?? null],
  );
  return rows;
}
