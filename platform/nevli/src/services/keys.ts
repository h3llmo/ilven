import { API_KEY_PREFIX, hmacHex, randomToken } from "@ilven/common";
import type { Ctx } from "../context.ts";

const hash = (ctx: Ctx, key: string) => hmacHex(ctx.masterKey, "ilven/api-key", key);

/** Issues a new Ilven API key for the user, revoking any previous one, and repoints their connexes. */
export async function issueApiKey(ctx: Ctx, userId: string): Promise<{ id: string; prefix: string }> {
  const key = API_KEY_PREFIX + randomToken(32);
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    await c.query("UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO api_keys (user_id, prefix, key_hash, sealed_key) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, prefix, hash(ctx, key), ctx.sealer.seal(key)],
    );
    await c.query("UPDATE connexes SET api_key_id = $2, updated_at = now() WHERE user_id = $1", [userId, rows[0].id]);
    await c.query("COMMIT");
    return { id: rows[0].id, prefix };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function revokeApiKey(ctx: Ctx, userId: string): Promise<boolean> {
  const r = await ctx.db.query("UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  await ctx.db.query("UPDATE connexes SET api_key_id = NULL, updated_at = now() WHERE user_id = $1", [userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function verifyApiKey(ctx: Ctx, key: string): Promise<{ userId: string; sub: string; isAdmin: boolean } | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const { rows } = await ctx.db.query<{ user_id: string; sub: string; is_admin: boolean }>(
    `SELECT k.user_id, u.sub, u.is_admin FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hash(ctx, key)],
  );
  return rows[0] ? { userId: rows[0].user_id, sub: rows[0].sub, isAdmin: rows[0].is_admin } : null;
}

export async function activeKeyInfo(ctx: Ctx, userId: string) {
  const { rows } = await ctx.db.query<{ id: string; prefix: string; created_at: Date }>(
    "SELECT id, prefix, created_at FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return rows[0] ? { id: rows[0].id, prefix: rows[0].prefix, createdAt: rows[0].created_at } : null;
}

/** Releases the plaintext key. Only used by the internal Ilven-AI session endpoint. */
export async function unsealApiKey(ctx: Ctx, apiKeyId: string): Promise<string | null> {
  const { rows } = await ctx.db.query<{ sealed_key: string }>(
    "SELECT sealed_key FROM api_keys WHERE id = $1 AND revoked_at IS NULL",
    [apiKeyId],
  );
  return rows[0] ? ctx.sealer.open(rows[0].sealed_key) : null;
}
