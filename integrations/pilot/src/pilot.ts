import { HttpError, type Caller, type Db, type Sealer } from "@ilven/common";

/**
 * Pilot's business logic, shared by its REST API (UI) and its MCP server (Ilven-AI through a connex).
 * The user's OpenAI key belongs to Pilot (encrypted in Pilot's own database); Ilven never sees it.
 */
export interface PilotCtx { db: Db; sealer: Sealer; dmsUrl: string; openaiModel: string }

export const SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
export type Size = (typeof SIZES)[number];

export async function hasOpenAiKey(ctx: PilotCtx, sub: string) {
  return (await ctx.db.query("SELECT 1 FROM settings WHERE owner_sub = $1", [sub])).rowCount === 1;
}

export async function setOpenAiKey(ctx: PilotCtx, sub: string, key: string) {
  await ctx.db.query(
    `INSERT INTO settings (owner_sub, sealed_openai_key) VALUES ($1, $2)
     ON CONFLICT (owner_sub) DO UPDATE SET sealed_openai_key = EXCLUDED.sealed_openai_key, updated_at = now()`,
    [sub, ctx.sealer.seal(key)],
  );
}

export async function deleteOpenAiKey(ctx: PilotCtx, sub: string) {
  await ctx.db.query("DELETE FROM settings WHERE owner_sub = $1", [sub]);
}

async function openAiKey(ctx: PilotCtx, sub: string): Promise<string> {
  const { rows } = await ctx.db.query<{ sealed_openai_key: string }>("SELECT sealed_openai_key FROM settings WHERE owner_sub = $1", [sub]);
  if (!rows[0]) throw new HttpError(409, "openai_key_missing", "No OpenAI API key is set. Add yours in Pilot's settings first.");
  return ctx.sealer.open(rows[0].sealed_openai_key);
}

/** DMS call made with the caller's own credential: the DMS enforces that users only touch their own files. */
async function dms(ctx: PilotCtx, caller: Caller, path: string, init: RequestInit = {}) {
  const res = await fetch(`${ctx.dmsUrl}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${caller.credential}` } });
  if (res.status === 404) throw new HttpError(404, "not_found", "Image not found");
  if (!res.ok) {
    console.warn(JSON.stringify({ msg: "dms error", status: res.status, path: path.split("?")[0], body: (await res.text().catch(() => "")).slice(0, 300) }));
    throw new HttpError(502, "dms_error", `Document store error (HTTP ${res.status})`);
  }
  return res;
}

export async function generateImage(ctx: PilotCtx, caller: Caller, prompt: string, size: Size = "1024x1024") {
  const key = await openAiKey(ctx, caller.sub);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: ctx.openaiModel, prompt, size, n: 1 }),
  });
  if (res.status === 401) throw new HttpError(409, "openai_key_rejected", "OpenAI rejected your API key. Update it in Pilot's settings.");
  if (!res.ok) {
    const err = ((await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; type?: string } }).error ?? {};
    console.warn(JSON.stringify({ msg: "openai image error", status: res.status, code: err.code, type: err.type, message: err.message?.slice(0, 300) }));
    throw new HttpError(502, "openai_error", `OpenAI could not generate the image (HTTP ${res.status}). ${(err.message ?? "").slice(0, 300)}`.trim());
  }
  const b64 = ((await res.json()) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, "openai_error", "OpenAI returned no image");
  const name = `${prompt.slice(0, 60).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "image"}.png`;
  const up = await dms(ctx, caller, `/dms/api/files?app=pilot&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-dms-metadata": JSON.stringify({ prompt: prompt.slice(0, 1000), size, model: ctx.openaiModel }) },
    body: Buffer.from(b64, "base64"),
  });
  const f = (await up.json()) as { id: string; name: string; createdAt: string };
  return { id: f.id, name: f.name, prompt, size, createdAt: f.createdAt };
}

export async function listImages(ctx: PilotCtx, caller: Caller, limit = 50) {
  const r = await dms(ctx, caller, `/dms/api/files?app=pilot&limit=${limit}`);
  const { files } = (await r.json()) as { files: { id: string; name: string; metadata: { prompt?: string; size?: string }; createdAt: string }[] };
  return files.map((f) => ({ id: f.id, name: f.name, prompt: f.metadata?.prompt ?? null, size: f.metadata?.size ?? null, createdAt: f.createdAt }));
}

export async function imageContent(ctx: PilotCtx, caller: Caller, id: string) {
  return dms(ctx, caller, `/dms/api/files/${encodeURIComponent(id)}/content`);
}

export async function deleteImage(ctx: PilotCtx, caller: Caller, id: string) {
  await dms(ctx, caller, `/dms/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { deleted: id };
}

/**
 * Vault data source ("ilven-vault-source/1"): read-only view of the user's generated images, so Locke-Vault can
 * search and stage them. Pilot stands in here for Locke's own generated-images source.
 */
export async function searchImages(ctx: PilotCtx, caller: Caller, q: { text?: string; from?: string; to?: string; addedAfter?: string; limit: number; cursor?: string }) {
  const p = new URLSearchParams({ app: "pilot", limit: String(q.limit) });
  if (q.text) p.set("q", q.text);
  if (q.addedAfter) {
    // New images since `addedAfter`, oldest first (vault workflows).
    p.set("order", "asc");
    const lo = Math.max(...[q.cursor, q.addedAfter, q.from].filter((d): d is string => !!d).map((d) => Date.parse(d)));
    p.set("after", new Date(lo).toISOString());
    if (q.to) p.set("before", q.to);
  } else {
    if (q.from) p.set("after", q.from);
    const before = q.cursor ?? q.to;
    if (before) p.set("before", before);
  }
  const r = await dms(ctx, caller, `/dms/api/files?${p}`);
  const { files } = (await r.json()) as { files: { id: string; name: string; contentType: string; size: number; metadata: { prompt?: string }; createdAt: string }[] };
  const items = files.map((f) => ({
    ref: f.id,
    name: f.name,
    contentType: f.contentType,
    size: f.size,
    date: new Date(f.createdAt).toISOString(),
    addedAt: new Date(f.createdAt).toISOString(),
    ...(f.metadata?.prompt ? { description: f.metadata.prompt.slice(0, 1000) } : {}),
  }));
  return { items, cursor: files.length === q.limit ? items[items.length - 1]!.date : null };
}
