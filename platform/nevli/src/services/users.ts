import { badRequest, conflict, notFound } from "@ilven/common";
import type { Ctx, Gender } from "../context.ts";
import { activeKeyInfo, issueApiKey } from "./keys.ts";
import { syncConnexes } from "./connexes.ts";

export interface UserRow { id: string; sub: string; is_admin: boolean; plan_id: string | null; birth_year: number | null; gender: Gender | null; created_at: Date }

export async function userBySub(ctx: Ctx, sub: string): Promise<UserRow | null> {
  return (await ctx.db.query<UserRow>("SELECT * FROM users WHERE sub = $1", [sub])).rows[0] ?? null;
}

export async function userById(ctx: Ctx, id: string): Promise<UserRow> {
  const u = (await ctx.db.query<UserRow>("SELECT * FROM users WHERE id = $1", [id])).rows[0];
  if (!u) throw notFound("User not found");
  return u;
}

/** Keeps the admin flag in line with the IdP (synced whenever the user calls Nevli with an identity token). */
export async function syncAdminFlag(ctx: Ctx, u: UserRow, isAdmin: boolean) {
  if (u.is_admin === isAdmin) return;
  await ctx.db.query("UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1", [u.id, isAdmin]);
  u.is_admin = isAdmin;
  await syncConnexes(ctx, { userId: u.id });
}

export interface ProfileInput { birthYear: number | null; gender: Gender | null }

export function validateProfile(p: ProfileInput) {
  const y = new Date().getUTCFullYear();
  if (p.birthYear != null && (p.birthYear < y - 120 || p.birthYear > y)) throw badRequest("Invalid birth year");
}

/** Registration (§5.1): create the Ilven-User, store only opted-in attributes, and on plan selection issue the API key + connexes. */
export async function registerUser(ctx: Ctx, sub: string, isAdmin: boolean, input: ProfileInput & { planId: string }) {
  validateProfile(input);
  const plan = await ctx.db.query("SELECT 1 FROM plans WHERE id = $1", [input.planId]);
  if (!plan.rowCount) throw badRequest("Unknown plan");
  let u: UserRow;
  try {
    u = (
      await ctx.db.query<UserRow>(
        "INSERT INTO users (sub, is_admin, plan_id, birth_year, gender) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [sub, isAdmin, input.planId, input.birthYear, input.gender],
      )
    ).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("Already registered");
    throw e;
  }
  await issueApiKey(ctx, u.id);
  await syncConnexes(ctx, { userId: u.id });
  return u;
}

/** Sharing off = attribute removed from Nevli (NULL). Connexes are re-resolved immediately. */
export async function updateProfile(ctx: Ctx, userId: string, p: ProfileInput) {
  validateProfile(p);
  await ctx.db.query("UPDATE users SET birth_year = $2, gender = $3, updated_at = now() WHERE id = $1", [userId, p.birthYear, p.gender]);
  await syncConnexes(ctx, { userId });
}

export async function deleteUser(ctx: Ctx, userId: string) {
  const r = await ctx.db.query("DELETE FROM users WHERE id = $1", [userId]);
  if (!r.rowCount) throw notFound("User not found");
}

export async function describeUser(ctx: Ctx, u: UserRow) {
  return {
    id: u.id,
    sub: u.sub,
    isAdmin: u.is_admin,
    planId: u.plan_id,
    profile: { birthYear: u.birth_year, gender: u.gender },
    apiKey: await activeKeyInfo(ctx, u.id),
    createdAt: u.created_at,
  };
}

export async function listUsers(ctx: Ctx) {
  const { rows } = await ctx.db.query<UserRow>("SELECT * FROM users ORDER BY created_at");
  return Promise.all(rows.map((u) => describeUser(ctx, u)));
}
