import { API_KEY_PREFIX, hmacHex, randomToken } from "@ilven/common";
import type { Ctx } from "../context.ts";

/**
 * Delegated keys (§6): let an app act for one user while that user is away, at a fixed list of services.
 * - Issued to the app (app secret) only while the user is logged in (their IdP token is checked by the caller).
 * - Same format as Ilven API keys ("ilv_…") so services verify them the same way, but valid only when the verifying
 *   service is in the key's audience. Services that don't name themselves never accept them.
 * - Never used by connexes or Ilven-AI, never unsealed: only a keyed hash is stored.
 */
const hash = (ctx: Ctx, key: string) => hmacHex(ctx.masterKey, "ilven/delegated-key", key);

export const AUDIENCE_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Services a delegated key may never reach: the control plane and the assistant. */
export const FORBIDDEN_AUDIENCE = new Set(["nevli", "ilven-ai"]);

export function checkAudience(audience: string[]): string | null {
  if (!audience.length) return "audience is empty";
  for (const a of audience) {
    if (!AUDIENCE_ID.test(a)) return `invalid audience "${a}"`;
    if (FORBIDDEN_AUDIENCE.has(a)) return `"${a}" can't be in a delegated key's audience`;
  }
  return null;
}

/** Issues a key for (user, app), revoking the app's previous key for this user. Returned once. */
export async function issueDelegatedKey(ctx: Ctx, userId: string, appId: string, audience: string[], purpose: string) {
  const key = API_KEY_PREFIX + randomToken(32);
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    await c.query("UPDATE delegated_keys SET revoked_at = now() WHERE user_id = $1 AND app_id = $2 AND revoked_at IS NULL", [userId, appId]);
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO delegated_keys (user_id, app_id, audience, purpose, prefix, key_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [userId, appId, [...new Set(audience)], purpose, prefix, hash(ctx, key)],
    );
    await c.query("COMMIT");
    return { id: rows[0]!.id, key, prefix };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** The key's user, if it is active and `service` is in its audience. */
export async function verifyDelegatedKey(ctx: Ctx, key: string, service: string | undefined) {
  if (!key.startsWith(API_KEY_PREFIX) || !service) return null;
  const { rows } = await ctx.db.query<{ id: string; user_id: string; sub: string; app_id: string; audience: string[]; stale: boolean }>(
    `SELECT d.id, d.user_id, u.sub, d.app_id, d.audience, (d.last_used_at IS NULL OR d.last_used_at < now() - interval '1 hour') AS stale
     FROM delegated_keys d JOIN users u ON u.id = d.user_id WHERE d.key_hash = $1 AND d.revoked_at IS NULL`,
    [hash(ctx, key)],
  );
  const r = rows[0];
  if (!r || !r.audience.includes(service)) return null;
  if (r.stale) await ctx.db.query("UPDATE delegated_keys SET last_used_at = now() WHERE id = $1", [r.id]);
  return { userId: r.user_id, sub: r.sub, delegatedTo: r.app_id };
}

export async function listDelegations(ctx: Ctx, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT d.id, d.app_id AS "appId", COALESCE(a.name, d.app_id) AS "appName", d.purpose, d.audience, d.prefix,
            d.created_at AS "createdAt", d.last_used_at AS "lastUsedAt"
     FROM delegated_keys d LEFT JOIN apps a ON a.id = d.app_id
     WHERE d.user_id = $1 AND d.revoked_at IS NULL ORDER BY d.created_at`,
    [userId],
  );
  return rows;
}

export async function revokeDelegation(ctx: Ctx, userId: string, id: string): Promise<boolean> {
  const r = await ctx.db.query("UPDATE delegated_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function revokeAppDelegation(ctx: Ctx, userId: string, appId: string): Promise<boolean> {
  const r = await ctx.db.query("UPDATE delegated_keys SET revoked_at = now() WHERE user_id = $1 AND app_id = $2 AND revoked_at IS NULL", [userId, appId]);
  return (r.rowCount ?? 0) > 0;
}
