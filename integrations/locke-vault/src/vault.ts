import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { badRequest, HttpError, notFound, type Caller, type Db, type Sealer } from "@ilven/common";
import { userKey, type UserKey } from "./crypto.ts";
import { EXT, sniff, type Accepted } from "./sniff.ts";
import type { SourceRegistry } from "./sources.ts";

/**
 * Locke-Vault business logic: an encrypted per-user staging area between Locke (and other apps) and Nevli-DMS.
 * An item is one staged file with its history: v1 is the original, every transformation adds a version.
 * Everything a user can recognise (titles, origins, operations, bytes) is encrypted with the user's data key;
 * Postgres only holds ids, sizes, types, timestamps and the owner's `sub`.
 */
export interface VaultCtx {
  db: Db;
  master: Sealer;
  dataDir: string;
  quotaBytes: number;
  maxFileBytes: number;
  dmsUrl: string;
  sources: SourceRegistry;
}

export const MIGRATIONS = [
  {
    id: "001_vault",
    sql: `
    CREATE TABLE vault_users (owner_sub text PRIMARY KEY, sealed_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE items (
      id uuid PRIMARY KEY,
      owner_sub text NOT NULL,
      sealed text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX items_owner ON items (owner_sub, updated_at DESC);
    CREATE TABLE versions (
      id uuid PRIMARY KEY,
      item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      owner_sub text NOT NULL,
      n int NOT NULL,
      parent int,
      content_type text NOT NULL,
      size bigint NOT NULL,
      sealed text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_id, n)
    );
    CREATE INDEX versions_owner ON versions (owner_sub);
    CREATE TABLE pushes (
      id bigserial PRIMARY KEY,
      item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      owner_sub text NOT NULL,
      version int NOT NULL,
      dms_file_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
  },
];

export const label = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,40}$/);
export const titleSchema = z.string().trim().min(1).max(200);

type Origin = { kind: "upload" } | { kind: "source"; source: string; ref: string; name: string };
type ItemMeta = { title: string; origin: Origin };
type VersionMeta = { app: string; operation: string; note?: string };

const aad = {
  item: (sub: string, id: string) => `item:${sub}:${id}`,
  version: (sub: string, id: string) => `version:${sub}:${id}`,
  blob: (sub: string, item: string, id: string) => `blob:${sub}:${item}:${id}`,
};

const blobPath = (ctx: VaultCtx, versionId: string) => join(ctx.dataDir, "blobs", versionId);
const uuidOr404 = (id: string, what = "Item") => {
  if (!z.uuid().safeParse(id).success) throw notFound(`${what} not found`);
};

export async function quota(ctx: VaultCtx, sub: string) {
  const { rows } = await ctx.db.query<{ used: string }>("SELECT coalesce(sum(size), 0) AS used FROM versions WHERE owner_sub = $1", [sub]);
  return { used: Number(rows[0]!.used), limit: ctx.quotaBytes };
}

function checkFile(ctx: VaultCtx, bytes: Buffer): Accepted {
  if (!bytes.length) throw badRequest("Empty file");
  if (bytes.length > ctx.maxFileBytes) throw new HttpError(413, "too_large", `Files are limited to ${Math.round(ctx.maxFileBytes / 1024 / 1024)} MB`);
  const type = sniff(bytes);
  if (!type) throw new HttpError(415, "unsupported_type", "Only images (PNG, JPEG, GIF, WebP, HEIC, AVIF) and PDF files can be staged");
  return type;
}

/**
 * Stores one encrypted version inside a transaction that holds the user's lock, so concurrent writes can't
 * overshoot the quota. The blob is written before commit and removed if the transaction fails.
 */
async function storeVersion(
  ctx: VaultCtx,
  sub: string,
  key: UserKey,
  bytes: Buffer,
  type: Accepted,
  item: { id: string; create?: ItemMeta },
  meta: VersionMeta,
  parent: number | null,
) {
  const c = await ctx.db.connect();
  const versionId = randomUUID();
  const path = blobPath(ctx, versionId);
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vault:${sub}`]);
    const used = Number((await c.query<{ used: string }>("SELECT coalesce(sum(size), 0) AS used FROM versions WHERE owner_sub = $1", [sub])).rows[0]!.used);
    if (used + bytes.length > ctx.quotaBytes) {
      const free = Math.max(0, ctx.quotaBytes - used);
      throw new HttpError(507, "vault_full", `Your vault is full (${mb(used)} of ${mb(ctx.quotaBytes)} used, ${mb(free)} free). Push or trash items to make room.`);
    }
    let n = 1;
    if (item.create) {
      await c.query("INSERT INTO items (id, owner_sub, sealed) VALUES ($1, $2, $3)", [item.id, sub, key.sealJson(item.create, aad.item(sub, item.id))]);
    } else {
      const r = await c.query<{ n: number | null }>(
        "SELECT max(v.n) AS n FROM items i LEFT JOIN versions v ON v.item_id = i.id WHERE i.id = $1 AND i.owner_sub = $2 GROUP BY i.id",
        [item.id, sub],
      );
      if (!r.rows[0]) throw notFound("Item not found");
      n = (r.rows[0].n ?? 0) + 1;
      if (parent !== null) {
        const p = await c.query("SELECT 1 FROM versions WHERE item_id = $1 AND n = $2", [item.id, parent]);
        if (!p.rowCount) throw badRequest(`Version ${parent} does not exist`);
      }
      await c.query("UPDATE items SET updated_at = now() WHERE id = $1", [item.id]);
    }
    await c.query(
      "INSERT INTO versions (id, item_id, owner_sub, n, parent, content_type, size, sealed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [versionId, item.id, sub, n, item.create ? null : (parent ?? n - 1), type, bytes.length, key.sealJson(meta, aad.version(sub, versionId))],
    );
    await writeFile(`${path}.part`, key.encrypt(bytes, aad.blob(sub, item.id, versionId)));
    await rename(`${path}.part`, path);
    await c.query("COMMIT");
    return n;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
    throw e;
  } finally {
    c.release();
  }
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

export async function stageUpload(ctx: VaultCtx, caller: Caller, bytes: Buffer, opts: { title?: string; app?: string }) {
  const type = checkFile(ctx, bytes);
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  const id = randomUUID();
  const title = opts.title ?? `Upload ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  await storeVersion(ctx, caller.sub, key, bytes, type, { id, create: { title, origin: { kind: "upload" } } }, { app: opts.app ?? "vault", operation: "upload" }, null);
  return getItem(ctx, caller, id);
}

export async function stageFromSource(ctx: VaultCtx, caller: Caller, sourceId: string, ref: string, title?: string) {
  const source = ctx.sources.get(sourceId);
  const f = await source.fetch(caller, ref);
  const type = checkFile(ctx, f.bytes);
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  const id = randomUUID();
  const create: ItemMeta = { title: title ?? f.name.slice(0, 200), origin: { kind: "source", source: sourceId, ref, name: f.name.slice(0, 300) } };
  await storeVersion(ctx, caller.sub, key, f.bytes, type, { id, create }, { app: "vault", operation: `import:${sourceId}` }, null);
  return getItem(ctx, caller, id);
}

export async function addVersion(ctx: VaultCtx, caller: Caller, itemId: string, bytes: Buffer, meta: { app: string; operation: string; note?: string; parent?: number }) {
  uuidOr404(itemId);
  const type = checkFile(ctx, bytes);
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  await storeVersion(ctx, caller.sub, key, bytes, type, { id: itemId }, { app: meta.app, operation: meta.operation, ...(meta.note ? { note: meta.note } : {}) }, meta.parent ?? null);
  return getItem(ctx, caller, itemId);
}

type ItemRow = { id: string; sealed: string; created_at: Date; updated_at: Date };
type VersionRow = { id: string; item_id: string; n: number; parent: number | null; content_type: string; size: string; sealed: string; created_at: Date };

function present(sub: string, key: UserKey, item: ItemRow, versions: VersionRow[], pushes: { version: number; dms_file_id: string; created_at: Date }[]) {
  const meta = key.openJson<ItemMeta>(item.sealed, aad.item(sub, item.id));
  const vs = versions
    .sort((a, b) => a.n - b.n)
    .map((v) => {
      const m = key.openJson<VersionMeta>(v.sealed, aad.version(sub, v.id));
      return { n: v.n, parent: v.parent, contentType: v.content_type, size: Number(v.size), app: m.app, operation: m.operation, note: m.note ?? null, createdAt: v.created_at };
    });
  return {
    id: item.id,
    title: meta.title,
    origin: meta.origin,
    currentVersion: vs[vs.length - 1]?.n ?? null,
    size: vs.reduce((s, v) => s + v.size, 0),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    versions: vs,
    pushes: pushes.map((p) => ({ version: p.version, dmsFileId: p.dms_file_id, pushedAt: p.created_at })),
  };
}

export type VaultItem = ReturnType<typeof present>;

export async function listItems(ctx: VaultCtx, caller: Caller, opts: { limit: number; before?: string }) {
  const { rows: items } = await ctx.db.query<ItemRow>(
    `SELECT id, sealed, created_at, updated_at FROM items WHERE owner_sub = $1 AND ($2::timestamptz IS NULL OR updated_at < $2)
     ORDER BY updated_at DESC LIMIT $3`,
    [caller.sub, opts.before ?? null, opts.limit],
  );
  if (!items.length) return { items: [], cursor: null };
  const ids = items.map((i) => i.id);
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  const { rows: versions } = await ctx.db.query<VersionRow>("SELECT * FROM versions WHERE item_id = ANY($1) AND owner_sub = $2", [ids, caller.sub]);
  const { rows: pushes } = await ctx.db.query<{ item_id: string; version: number; dms_file_id: string; created_at: Date }>(
    "SELECT item_id, version, dms_file_id, created_at FROM pushes WHERE item_id = ANY($1) AND owner_sub = $2 ORDER BY created_at",
    [ids, caller.sub],
  );
  return {
    items: items.map((i) => present(caller.sub, key, i, versions.filter((v) => v.item_id === i.id), pushes.filter((p) => p.item_id === i.id))),
    cursor: items.length === opts.limit ? items[items.length - 1]!.updated_at.toISOString() : null,
  };
}

export async function getItem(ctx: VaultCtx, caller: Caller, id: string) {
  uuidOr404(id);
  const { rows } = await ctx.db.query<ItemRow>("SELECT id, sealed, created_at, updated_at FROM items WHERE id = $1 AND owner_sub = $2", [id, caller.sub]);
  if (!rows[0]) throw notFound("Item not found"); // same answer whether it doesn't exist or isn't yours
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  const { rows: versions } = await ctx.db.query<VersionRow>("SELECT * FROM versions WHERE item_id = $1 AND owner_sub = $2", [id, caller.sub]);
  const { rows: pushes } = await ctx.db.query<{ version: number; dms_file_id: string; created_at: Date }>(
    "SELECT version, dms_file_id, created_at FROM pushes WHERE item_id = $1 AND owner_sub = $2 ORDER BY created_at",
    [id, caller.sub],
  );
  return present(caller.sub, key, rows[0], versions, pushes);
}

export async function renameItem(ctx: VaultCtx, caller: Caller, id: string, title: string) {
  const item = await getItem(ctx, caller, id);
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  await ctx.db.query("UPDATE items SET sealed = $3, updated_at = now() WHERE id = $1 AND owner_sub = $2", [
    id,
    caller.sub,
    key.sealJson({ title, origin: item.origin } satisfies ItemMeta, aad.item(caller.sub, id)),
  ]);
  return getItem(ctx, caller, id);
}

/** Decrypted bytes of one version (the latest when `n` is omitted). */
export async function versionContent(ctx: VaultCtx, caller: Caller, id: string, n?: number) {
  uuidOr404(id);
  const { rows } = await ctx.db.query<{ id: string; n: number; content_type: Accepted; sealed: string }>(
    `SELECT v.id, v.n, v.content_type FROM versions v JOIN items i ON i.id = v.item_id
     WHERE v.item_id = $1 AND i.owner_sub = $2 AND v.owner_sub = $2 AND ($3::int IS NULL OR v.n = $3) ORDER BY v.n DESC LIMIT 1`,
    [id, caller.sub, n ?? null],
  );
  const v = rows[0];
  if (!v) throw notFound("Version not found");
  const key = await userKey(ctx.db, ctx.master, caller.sub);
  const blob = await readFile(blobPath(ctx, v.id)).catch(() => { throw notFound("Version content missing"); });
  const item = await getItem(ctx, caller, id);
  const base = item.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "file";
  return { bytes: key.decrypt(blob, aad.blob(caller.sub, id, v.id)), contentType: v.content_type, n: v.n, name: `${base}-v${v.n}.${EXT[v.content_type]}`, item };
}

export async function trashItem(ctx: VaultCtx, caller: Caller, id: string) {
  uuidOr404(id);
  const { rows: versions } = await ctx.db.query<{ id: string }>("SELECT id FROM versions WHERE item_id = $1 AND owner_sub = $2", [id, caller.sub]);
  const del = await ctx.db.query("DELETE FROM items WHERE id = $1 AND owner_sub = $2", [id, caller.sub]);
  if (!del.rowCount) throw notFound("Item not found");
  // Version rows go by cascade; their blobs are removed here (the startup sweep catches anything left behind).
  for (const v of versions) await rm(blobPath(ctx, v.id), { force: true });
  return { trashed: id };
}

export async function trashVersion(ctx: VaultCtx, caller: Caller, id: string, n: number) {
  const item = await getItem(ctx, caller, id);
  if (!item.versions.some((v) => v.n === n)) throw notFound("Version not found");
  if (item.versions.length === 1) throw badRequest("This is the only version: trash the whole item instead");
  const { rows } = await ctx.db.query<{ id: string }>("DELETE FROM versions WHERE item_id = $1 AND owner_sub = $2 AND n = $3 RETURNING id", [id, caller.sub, n]);
  for (const r of rows) await rm(blobPath(ctx, r.id), { force: true });
  await ctx.db.query("UPDATE items SET updated_at = now() WHERE id = $1", [id]);
  return getItem(ctx, caller, id);
}

/** Saves a chosen version (default: latest) to Nevli-DMS with the user's own credential. The item stays staged. */
export async function pushToDms(ctx: VaultCtx, caller: Caller, id: string, n?: number) {
  const v = await versionContent(ctx, caller, id, n);
  const meta = {
    vaultItem: id,
    vaultVersion: v.n,
    title: v.item.title.slice(0, 200),
    origin: v.item.origin.kind === "source" ? `${v.item.origin.source}:${v.item.origin.ref}`.slice(0, 300) : "upload",
    history: v.item.versions.filter((x) => x.n <= v.n).map((x) => `v${x.n} ${x.app}/${x.operation}`).join(", ").slice(0, 1500),
  };
  const res = await fetch(`${ctx.dmsUrl}/dms/api/files?app=locke-vault&name=${encodeURIComponent(v.name)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${caller.credential}`, "content-type": v.contentType, "x-dms-metadata": JSON.stringify(meta) },
    body: new Uint8Array(v.bytes),
  }).catch(() => { throw new HttpError(503, "dms_unavailable", "The document store is not reachable"); });
  if (!res.ok) {
    console.warn(JSON.stringify({ msg: "dms push error", status: res.status }));
    throw new HttpError(502, "dms_error", `The document store refused the file (HTTP ${res.status})`);
  }
  const f = (await res.json()) as { id: string };
  await ctx.db.query("INSERT INTO pushes (item_id, owner_sub, version, dms_file_id) VALUES ($1, $2, $3, $4)", [id, caller.sub, v.n, f.id]);
  return { item: id, version: v.n, dmsFileId: f.id };
}

/**
 * Removes blob files that no version row references (left behind by a crash or a failed delete).
 * Only files older than `minAgeMs` are considered, so a write whose transaction hasn't committed yet is never touched.
 */
export async function sweepOrphans(ctx: VaultCtx, minAgeMs = 15 * 60_000) {
  const dir = join(ctx.dataDir, "blobs");
  const names = await readdir(dir).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const f of names) {
    const m = /^([0-9a-f-]{36})(\.part)?$/.exec(f);
    if (!m) continue;
    const st = await stat(join(dir, f)).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < minAgeMs) continue;
    if (m[2]) await rm(join(dir, f), { force: true });
    else ids.push(f);
  }
  if (!ids.length) return 0;
  const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM versions WHERE id = ANY($1::uuid[])", [ids]);
  const live = new Set(rows.map((r) => r.id));
  let removed = 0;
  for (const f of ids) {
    if (!live.has(f)) {
      await rm(blobPath(ctx, f), { force: true });
      removed++;
    }
  }
  return removed;
}
