import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { badRequest, createCallerAuthenticator, createDb, createServer, env, envInt, forbidden, HttpError, listen, migrate, retry, Sealer, secret, unauthorized, type Caller } from "@ilven/common";
import { mountMcp, McpServer, toolResult } from "@ilven/common/mcp";
import { Icloud, ICLOUD_MIGRATION } from "./icloud.ts";
import { sniff } from "./sniff.ts";
import { DmsSource, HttpSource, sourceConfigSchema, sourceQuerySchema, SourceRegistry } from "./sources.ts";
import {
  addVersion, getItem, label, listItems, MIGRATIONS, pushToDms, quota, renameItem, stageFromSource, stageUpload, sweepOrphans,
  titleSchema, trashItem, trashVersion, versionContent, type VaultCtx,
} from "./vault.ts";

const PREFIX = "/apps/locke-vault";
const MAX_FILE = envInt("VAULT_MAX_FILE_BYTES", 25 * 1024 * 1024);
const DMS_URL = env("DMS_URL", "http://nevli-dms:3000");
const dataDir = env("VAULT_DATA_DIR", "/data");

const db = createDb();
const masterHex = secret("VAULT_MASTER_KEY");
const master = new Sealer(masterHex);
const icloudToken = env("ICLOUD_TOKEN_FILE", "") ? secret("ICLOUD_TOKEN") : "";
const icloud = icloudToken ? new Icloud(db, master, masterHex, env("ICLOUD_URL", "http://locke-vault-icloud:8000"), icloudToken, MAX_FILE) : null;
const sources = new SourceRegistry([
  new DmsSource(DMS_URL, MAX_FILE),
  ...sourceConfigSchema.parse(JSON.parse(env("VAULT_SOURCES", "[]"))).map((s) => new HttpSource(s.id, s.url.replace(/\/$/, ""), MAX_FILE)),
  ...(icloud ? [icloud] : []),
]);

const ctx: VaultCtx = {
  db,
  master,
  dataDir,
  quotaBytes: envInt("VAULT_QUOTA_BYTES", 256 * 1024 * 1024),
  maxFileBytes: MAX_FILE,
  dmsUrl: DMS_URL,
  sources,
};

await retry("database", () => db.query("SELECT 1"));
await migrate(db, [...MIGRATIONS, ICLOUD_MIGRATION]);
await mkdir(join(dataDir, "blobs"), { recursive: true });
void sweepOrphans(ctx).then((n) => n && console.log(`[vault] removed ${n} orphan blob(s)`)).catch((e) => console.error("[vault] sweep failed", e));

/** Inline only for types browsers render safely; everything is sandboxed and never sniffed. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf"]);
function sendFile(reply: FastifyReply, bytes: Buffer, type: string, name: string) {
  const inline = INLINE.has(type);
  return reply
    .header("content-type", inline ? type : "application/octet-stream")
    .header("content-length", bytes.length)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "private, no-store")
    .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`)
    .send(bytes);
}

// ---------- REST: the viewer (user's IdP token) and Locke's back-end (the user's credential, conventional calls) ----------
const web = createServer();
const auth = createCallerAuthenticator({ allowApiKey: true });
web.addContentTypeParser(["application/octet-stream", "application/pdf"], { parseAs: "buffer", bodyLimit: MAX_FILE + 1024 }, (_r, b, done) => done(null, b));
web.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: MAX_FILE + 1024 }, (_r, b, done) => done(null, b));
const body = (b: unknown) => {
  if (!Buffer.isBuffer(b)) throw badRequest("Send the file as the raw request body (e.g. Content-Type: image/png)");
  return b;
};
const idParam = (p: unknown) => z.object({ id: z.string() }).parse(p).id;
const nParam = (p: unknown) => z.object({ n: z.coerce.number().int().min(1) }).parse(p).n;
const A = `${PREFIX}/api`;

web.get(`${A}/quota`, async (req) => quota(ctx, (await auth(req)).sub));

web.get(`${A}/items`, async (req) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
  return listItems(ctx, await auth(req), { limit: q.limit, before: q.cursor });
});
web.post(`${A}/items`, async (req, reply) => {
  const c = await auth(req);
  const q = z.object({ title: titleSchema.optional(), app: label.optional() }).parse(req.query);
  return reply.status(201).send(await stageUpload(ctx, c, body(req.body), q));
});
web.post(`${A}/items/from-source`, async (req, reply) => {
  const c = await auth(req);
  const b = z.object({ source: z.string().max(40), ref: z.string().min(1).max(500), title: titleSchema.optional() }).parse(req.body);
  return reply.status(201).send(await stageFromSource(ctx, c, b.source, b.ref, b.title));
});
web.get(`${A}/items/:id`, async (req) => getItem(ctx, await auth(req), idParam(req.params)));
web.patch(`${A}/items/:id`, async (req) => renameItem(ctx, await auth(req), idParam(req.params), z.object({ title: titleSchema }).parse(req.body).title));
web.delete(`${A}/items/:id`, async (req) => trashItem(ctx, await auth(req), idParam(req.params)));

web.post(`${A}/items/:id/versions`, async (req, reply) => {
  const c = await auth(req);
  const q = z.object({ app: label, operation: label, note: z.string().max(500).optional(), parent: z.coerce.number().int().min(1).optional() }).parse(req.query);
  return reply.status(201).send(await addVersion(ctx, c, idParam(req.params), body(req.body), q));
});
web.get(`${A}/items/:id/content`, async (req, reply) => {
  const v = await versionContent(ctx, await auth(req), idParam(req.params));
  return sendFile(reply, v.bytes, v.contentType, v.name);
});
web.get(`${A}/items/:id/versions/:n/content`, async (req, reply) => {
  const v = await versionContent(ctx, await auth(req), idParam(req.params), nParam(req.params));
  return sendFile(reply, v.bytes, v.contentType, v.name);
});
web.delete(`${A}/items/:id/versions/:n`, async (req) => trashVersion(ctx, await auth(req), idParam(req.params), nParam(req.params)));
web.post(`${A}/items/:id/push`, async (req) => {
  const b = z.object({ version: z.int().min(1).optional() }).parse(req.body ?? {});
  return pushToDms(ctx, await auth(req), idParam(req.params), b.version);
});

web.get(`${A}/sources`, async (req) => ({ sources: await sources.list(await auth(req)) }));
web.post(`${A}/sources/:source/query`, async (req) => {
  const c = await auth(req);
  const { source } = z.object({ source: z.string().max(40) }).parse(req.params);
  return sources.get(source).query(c, sourceQuerySchema.parse(req.body ?? {}));
});
// Preview a source file without staging it (read-only, nothing stored).
web.get(`${A}/sources/:source/items/:ref/content`, async (req, reply) => {
  const c = await auth(req);
  const { source, ref } = z.object({ source: z.string().max(40), ref: z.string().min(1).max(500) }).parse(req.params);
  const f = await sources.get(source).fetch(c, ref);
  const type = sniff(f.bytes);
  if (!type) return reply.status(415).send({ error: "unsupported_type", message: "This file type can't be previewed or staged" });
  return sendFile(reply, f.bytes, type, f.name);
});

web.get(`${A}/me`, async (req) => {
  const c = await auth(req);
  return { isAdmin: c.kind === "identity" && c.isAdmin, experimental: { icloud: icloud ? await icloud.access(c.sub) : "unavailable" } };
});

// ---------- Experimental iCloud source: per-user access, connection and album ----------
const needIcloud = () => {
  if (!icloud) throw new HttpError(404, "not_found", "The iCloud connector is not installed");
  return icloud;
};
const requireAdmin = (c: Caller) => {
  if (c.kind !== "identity" || !c.isAdmin) throw forbidden("Administrators only");
};
const X = `${A}/experimental/icloud`;
web.get(X, async (req) => needIcloud().status(await auth(req)));
web.post(`${X}/request-access`, async (req) => needIcloud().requestAccess(await auth(req)));
web.post(`${X}/connect`, async (req) => {
  const b = z.object({ appleId: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }).parse(req.body);
  return needIcloud().connect(await auth(req), b.appleId, b.password);
});
web.post(`${X}/verify`, async (req) => needIcloud().verify(await auth(req), z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body).code));
web.post(`${X}/disconnect`, async (req) => needIcloud().disconnect(await auth(req)));
web.get(`${X}/albums`, async (req) => needIcloud().albums(await auth(req)));
web.put(`${X}/album`, async (req) => needIcloud().setAlbum(await auth(req), z.object({ album: z.string().trim().min(1).max(200) }).parse(req.body).album));
web.get(`${A}/admin/experimental`, async (req) => {
  requireAdmin(await auth(req));
  return { icloud: await needIcloud().listAccess() };
});
web.post(`${A}/admin/experimental/:id`, async (req) => {
  requireAdmin(await auth(req));
  const { status } = z.object({ status: z.enum(["granted", "revoked", "removed"]) }).parse(req.body);
  return needIcloud().decide(idParam(req.params), status);
});

const here = dirname(fileURLToPath(import.meta.url));
web.register(fastifyStatic, { root: join(here, "web"), prefix: `${PREFIX}/`, index: "index.html" });
web.get(PREFIX, (_req, reply) => reply.redirect(`${PREFIX}/`));

// ---------- MCP server for Ilven-AI (internal network only, user's Ilven API key) ----------
const mcp = createServer();
mountMcp(mcp, "/mcp", async (req) => {
  // Listing tools needs no credential (Nevli discovery). Every call needs a valid Ilven API key.
  const caller = req.headers.authorization ? await auth(req).catch(() => null) : null;
  const need = () => {
    if (!caller || caller.kind !== "apiKey") throw unauthorized("An Ilven API key is required");
    return caller;
  };
  const brief = (i: Awaited<ReturnType<typeof getItem>>) => ({
    id: i.id, title: i.title, origin: i.origin, versions: i.versions.length, currentVersion: i.currentVersion, size: i.size, updatedAt: i.updatedAt,
    savedToDocuments: i.pushes.map((p) => `v${p.version}`),
  });
  const s = new McpServer({ name: "locke-vault", version: "0.1.0" });
  s.registerTool(
    "list_staged",
    { title: "List staged files", description: "List the user's staged files in their Locke vault, most recently changed first, with their versions and storage used.", inputSchema: { limit: z.int().min(1).max(50).default(20) }, annotations: { readOnlyHint: true } },
    async ({ limit }) => toolResult(async () => {
      const c = need();
      const [r, q] = await Promise.all([listItems(ctx, c, { limit }), quota(ctx, c.sub)]);
      return { items: r.items.map(brief), quota: { usedBytes: q.used, limitBytes: q.limit } };
    }),
  );
  s.registerTool(
    "get_staged",
    { title: "Get staged file", description: "Details of one staged file: its full version history (which app made each version and how) and where it was saved.", inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: true } },
    async ({ id }) => toolResult(() => getItem(ctx, need(), id)),
  );
  s.registerTool(
    "list_sources",
    { title: "List data sources", description: "The read-only data sources the user can search for files to stage (e.g. their Ilven documents, generated images).", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult(async () => ({ sources: await sources.list(need()) })),
  );
  s.registerTool(
    "search_source",
    {
      title: "Search a data source",
      description: "Search one data source for the user's files. Read-only: nothing is staged or changed.",
      inputSchema: {
        source: z.string().max(40).describe("Source id from list_sources"),
        text: z.string().max(200).optional().describe("Words to look for in names or descriptions"),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        favorite: z.boolean().optional(),
        collection: z.string().min(1).max(100).optional().describe("Collection id from list_sources (sources that offer collections)"),
        addedAfter: z.iso.datetime({ offset: true }).optional().describe("Only items added after this instant, oldest first (sources that support it)"),
        limit: z.int().min(1).max(50).default(20),
        cursor: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ source, ...q }) => toolResult(() => sources.get(source).query(need(), sourceQuerySchema.parse(q))),
  );
  s.registerTool(
    "stage_from_source",
    { title: "Stage a file from a source", description: "Copy one file from a data source into the user's vault (encrypted) as a new staged file.", inputSchema: { source: z.string().max(40), ref: z.string().min(1).max(500), title: titleSchema.optional() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async ({ source, ref, title }) => toolResult(async () => brief(await stageFromSource(ctx, need(), source, ref, title))),
  );
  s.registerTool(
    "save_to_documents",
    { title: "Save to documents", description: "Save one version of a staged file (latest by default) to the user's Ilven documents. The file stays staged.", inputSchema: { id: z.uuid(), version: z.int().min(1).optional() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async ({ id, version }) => toolResult(() => pushToDms(ctx, need(), id, version)),
  );
  s.registerTool(
    "trash_staged",
    { title: "Trash staged file", description: "Permanently delete a staged file and all its versions from the vault. Copies already saved to documents are kept.", inputSchema: { id: z.uuid() }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async ({ id }) => toolResult(() => trashItem(ctx, need(), id)),
  );
  s.registerTool(
    "trash_version",
    { title: "Trash one version", description: "Permanently delete one version of a staged file (not the only one).", inputSchema: { id: z.uuid(), version: z.int().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async ({ id, version }) => toolResult(async () => brief(await trashVersion(ctx, need(), id, version))),
  );
  return s;
});

await listen(web, 8080);
await listen(mcp, 8081);

// ---------- Register with Nevli (in the background; the vault works without Ilven-AI) ----------
const nevli = env("NEVLI_INTERNAL_URL", "http://nevli:3001");
const appSecret = readFileSync(env("VAULT_APP_SECRET_FILE"), "utf8").trim();
void retry("register with Nevli", async () => {
  const res = await fetch(`${nevli}/internal/apps/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "locke-vault", name: "Locke Vault", mcpUrl: env("VAULT_MCP_URL", "http://app-locke-vault:8081/mcp"), baseUrl: `${PREFIX}/`, secret: appSecret }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log("[vault] registered with Nevli");
}, 1000, 3000).catch((e) => console.error("[vault] registration with Nevli failed", e));
