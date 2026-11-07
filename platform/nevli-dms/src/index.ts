import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { badRequest, createCallerAuthenticator, createDb, createServer, env, envInt, listen, migrate, notFound, retry, sha256Hex, type Caller } from "@ilven/common";

/**
 * Nevli-DMS: minimal document store. Binaries live on a Docker volume; metadata in Postgres.
 * Permissions are enforced here, at the API level: every file belongs to one user (IdP `sub`) and only they can access it.
 * Callers authenticate with the user's IdP token (UI) or the user's Ilven API key (apps acting through a connex).
 */
const DATA = env("DMS_DATA_DIR", "/data");
const MAX_BYTES = envInt("DMS_MAX_UPLOAD_BYTES", 25 * 1024 * 1024);
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]);

const db = createDb();
await retry("database", () => db.query("SELECT 1"));
await migrate(db, [
  {
    id: "001_files",
    sql: `CREATE TABLE files (
      id uuid PRIMARY KEY,
      owner_sub text NOT NULL,
      app_id text,
      name text NOT NULL,
      content_type text NOT NULL,
      size bigint NOT NULL,
      sha256 text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX files_owner ON files (owner_sub, created_at DESC);`,
  },
]);
await mkdir(join(DATA, "files"), { recursive: true });

const authenticate = createCallerAuthenticator({ allowApiKey: true });
const app = createServer();
// Every upload body is raw bytes, whatever its content type (no JSON/text parsing).
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

const COLS = `id, app_id AS "appId", name, content_type AS "contentType", size::int AS size, sha256, metadata, created_at AS "createdAt"`;
const pathOf = (id: string) => join(DATA, "files", id);

async function own(caller: Caller, id: string) {
  if (!z.uuid().safeParse(id).success) throw notFound("File not found");
  const { rows } = await db.query(`SELECT ${COLS} FROM files WHERE id = $1 AND owner_sub = $2`, [id, caller.sub]);
  if (!rows[0]) throw notFound("File not found"); // same answer whether it doesn't exist or isn't yours
  return rows[0] as { id: string; name: string; contentType: string; size: number };
}

app.post("/dms/api/files", async (req, reply) => {
  const caller = await authenticate(req);
  const q = z.object({ name: z.string().min(1).max(200), app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).optional() }).parse(req.query);
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("Empty body");
  const contentType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  let metadata: unknown = {};
  const mh = req.headers["x-dms-metadata"];
  if (typeof mh === "string") {
    if (mh.length > 4096) throw badRequest("Metadata too large");
    metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(mh));
  }
  const id = randomUUID();
  const tmp = `${pathOf(id)}.part`;
  await writeFile(tmp, body);
  await rename(tmp, pathOf(id));
  const { rows } = await db.query(
    `INSERT INTO files (id, owner_sub, app_id, name, content_type, size, sha256, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
    [id, caller.sub, q.app ?? null, q.name, contentType, body.length, sha256Hex(body), JSON.stringify(metadata)],
  );
  return reply.status(201).send(rows[0]);
});

app.get("/dms/api/files", async (req) => {
  const caller = await authenticate(req);
  const q = z
    .object({
      app: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.iso.datetime({ offset: true }).optional(),
      after: z.iso.datetime({ offset: true }).optional(),
      q: z.string().max(200).optional(), // words in the name or metadata
    })
    .parse(req.query);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const { rows } = await db.query(
    `SELECT ${COLS} FROM files WHERE owner_sub = $1 AND ($2::text IS NULL OR app_id = $2) AND ($3::timestamptz IS NULL OR created_at < $3)
       AND ($4::timestamptz IS NULL OR created_at > $4) AND ($5::text IS NULL OR name ILIKE $5 OR EXISTS (SELECT 1 FROM jsonb_each_text(metadata) m WHERE m.value ILIKE $5))
     ORDER BY created_at DESC LIMIT $6`,
    [caller.sub, q.app ?? null, q.before ?? null, q.after ?? null, like, q.limit],
  );
  return { files: rows };
});

app.get("/dms/api/files/:id", async (req) => own(await authenticate(req), (req.params as { id: string }).id));

app.get("/dms/api/files/:id/content", async (req, reply) => {
  const f = await own(await authenticate(req), (req.params as { id: string }).id);
  await stat(pathOf(f.id)).catch(() => { throw notFound("File content missing"); });
  const inline = INLINE_TYPES.has(f.contentType);
  reply
    .header("content-type", inline ? f.contentType : "application/octet-stream")
    .header("content-length", f.size)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "private, max-age=300")
    .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(f.name)}"`);
  return reply.send(createReadStream(pathOf(f.id)));
});

app.delete("/dms/api/files/:id", async (req) => {
  const caller = await authenticate(req);
  const f = await own(caller, (req.params as { id: string }).id);
  await db.query("DELETE FROM files WHERE id = $1 AND owner_sub = $2", [f.id, caller.sub]);
  await rm(pathOf(f.id), { force: true });
  return { deleted: f.id };
});

await listen(app, 3000);
