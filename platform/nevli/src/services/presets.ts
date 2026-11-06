import { badRequest, conflict, notFound } from "@ilven/common";
import type { ConversationScope, Ctx, Gender } from "../context.ts";
import { syncConnexes } from "./connexes.ts";

const COLS = `id, app_id AS "appId", name, is_default AS "isDefault", tools, rules, conversation, topics, updated_at AS "updatedAt"`;
type PresetInput = { name?: string; tools?: string[]; rules?: string; conversation?: ConversationScope; topics?: string };

async function appExists(ctx: Ctx, appId: string) {
  if (!(await ctx.db.query("SELECT 1 FROM apps WHERE id = $1", [appId])).rowCount) throw notFound("App not found");
}

export async function listPresets(ctx: Ctx, appId: string) {
  await appExists(ctx, appId);
  return (await ctx.db.query(`SELECT ${COLS} FROM presets WHERE app_id = $1 ORDER BY is_default DESC, name`, [appId])).rows;
}

export async function getPreset(ctx: Ctx, presetId: string) {
  const p = (await ctx.db.query(`SELECT ${COLS} FROM presets WHERE id = $1`, [presetId])).rows[0];
  if (!p) throw notFound("Preset not found");
  return p as { id: string; appId: string; name: string; isDefault: boolean; tools: string[]; rules: string; conversation: ConversationScope; topics: string };
}

export async function createPreset(ctx: Ctx, appId: string, p: { name: string; tools: string[]; rules: string; conversation: ConversationScope; topics: string }) {
  await appExists(ctx, appId);
  try {
    const { rows } = await ctx.db.query(
      `INSERT INTO presets (app_id, name, tools, rules, conversation, topics) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [appId, p.name, dedupe(p.tools), p.rules, p.conversation, p.topics],
    );
    return rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A preset with this name already exists for this app");
    throw e;
  }
}

export async function updatePreset(ctx: Ctx, presetId: string, p: PresetInput) {
  const cur = await getPreset(ctx, presetId);
  const { rows } = await ctx.db.query(
    `UPDATE presets SET name = COALESCE($2, name), tools = COALESCE($3, tools), rules = COALESCE($4, rules),
       conversation = COALESCE($5, conversation), topics = COALESCE($6, topics), updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    [presetId, p.name ?? null, p.tools ? dedupe(p.tools) : null, p.rules ?? null, p.conversation ?? null, p.topics ?? null],
  );
  await syncConnexes(ctx, { appId: cur.appId });
  return rows[0];
}

export async function deletePreset(ctx: Ctx, presetId: string) {
  const cur = await getPreset(ctx, presetId);
  if (cur.isDefault) throw badRequest("The default preset cannot be deleted");
  await ctx.db.query("DELETE FROM presets WHERE id = $1", [presetId]);
  await syncConnexes(ctx, { appId: cur.appId });
  return { deleted: presetId };
}

export async function listCriteria(ctx: Ctx, appId: string) {
  await appExists(ctx, appId);
  return (
    await ctx.db.query(
      `SELECT c.id, c.preset_id AS "presetId", p.name AS "presetName", c.priority, c.min_age AS "minAge", c.max_age AS "maxAge", c.gender
       FROM preset_criteria c JOIN presets p ON p.id = c.preset_id WHERE c.app_id = $1 ORDER BY c.priority, c.id`,
      [appId],
    )
  ).rows;
}

export async function createCriterion(ctx: Ctx, appId: string, c: { presetId: string; priority: number; minAge?: number | null; maxAge?: number | null; gender?: Gender | null }) {
  const preset = await getPreset(ctx, c.presetId);
  if (preset.appId !== appId) throw badRequest("Preset belongs to another app");
  if (c.minAge != null && c.maxAge != null && c.minAge > c.maxAge) throw badRequest("minAge must be <= maxAge");
  const { rows } = await ctx.db.query(
    `INSERT INTO preset_criteria (app_id, preset_id, priority, min_age, max_age, gender) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, preset_id AS "presetId", priority, min_age AS "minAge", max_age AS "maxAge", gender`,
    [appId, c.presetId, c.priority, c.minAge ?? null, c.maxAge ?? null, c.gender ?? null],
  );
  await syncConnexes(ctx, { appId });
  return rows[0];
}

export async function deleteCriterion(ctx: Ctx, criterionId: string) {
  const { rows } = await ctx.db.query<{ app_id: string }>("DELETE FROM preset_criteria WHERE id = $1 RETURNING app_id", [criterionId]);
  if (!rows[0]) throw notFound("Criterion not found");
  await syncConnexes(ctx, { appId: rows[0].app_id });
  return { deleted: criterionId };
}

const dedupe = (a: string[]) => [...new Set(a)];
