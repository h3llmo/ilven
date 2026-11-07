import { z } from "zod";
import { HttpError, notFound, type Caller } from "@ilven/common";

/**
 * Vault data sources: one read-only entry point onto other systems (Nevli-DMS, Ilven-Apps such as Locke or Pilot,
 * later iCloud through a sidecar). A source can only be queried and read: the contract has no write operation.
 *
 * HTTP contract ("ilven-vault-source/1"), implemented by any external source at a base URL:
 *   GET  {base}                       → SourceInfo
 *   POST {base}/query   SourceQuery   → { items: SourceItem[], cursor: string | null }
 *   GET  {base}/items/{ref}/content   → the file bytes
 * The vault calls it with the user's own credential (IdP token or Ilven API key), so a source only ever returns
 * that user's files.
 */
export const sourceQuerySchema = z.object({
  text: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  favorite: z.boolean().optional(),
  limit: z.int().min(1).max(100).default(30),
  cursor: z.string().max(500).optional(),
});
export type SourceQuery = z.infer<typeof sourceQuerySchema>;

export const sourceItemSchema = z.object({
  ref: z.string().min(1).max(500),
  name: z.string().max(300),
  contentType: z.string().max(100).optional(),
  size: z.number().int().nonnegative().optional(),
  date: z.string().max(40).optional(),
  favorite: z.boolean().optional(),
  description: z.string().max(1000).optional(),
});
export type SourceItem = z.infer<typeof sourceItemSchema>;

export const sourceInfoSchema = z.object({
  name: z.string().max(80),
  description: z.string().max(300).default(""),
  /** Per-user readiness: a source may need setup (or not be allowed) for this user while working for others. */
  status: z.enum(["ready", "needs_setup", "not_allowed"]).default("ready"),
  experimental: z.boolean().default(false),
  filters: z.object({ text: z.boolean().default(false), dateRange: z.boolean().default(false), favorite: z.boolean().default(false) }).default({ text: false, dateRange: false, favorite: false }),
});
export type SourceInfo = z.infer<typeof sourceInfoSchema>;

const pageSchema = z.object({ items: z.array(sourceItemSchema).max(100), cursor: z.string().max(500).nullable().default(null) });
export type SourcePage = z.infer<typeof pageSchema>;

export interface DataSource {
  readonly id: string;
  info(caller: Caller): Promise<SourceInfo>;
  query(caller: Caller, q: SourceQuery): Promise<SourcePage>;
  fetch(caller: Caller, ref: string): Promise<{ bytes: Buffer; name: string }>;
}

const TIMEOUT_MS = 30_000;

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, "too_large", `The file is larger than ${Math.round(max / 1024 / 1024)} MB`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) throw new HttpError(413, "too_large", `The file is larger than ${Math.round(max / 1024 / 1024)} MB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function upstreamError(id: string, res: Response): never {
  if (res.status === 404) throw notFound(`Not found in source "${id}"`);
  if (res.status === 401 || res.status === 403) throw new HttpError(502, "source_denied", `Source "${id}" refused access for this user`);
  throw new HttpError(502, "source_error", `Source "${id}" failed (HTTP ${res.status})`);
}

/** Any system implementing the HTTP contract. */
export class HttpSource implements DataSource {
  constructor(readonly id: string, private readonly base: string, private readonly maxBytes: number) {}

  private async call(caller: Caller, path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${caller.credential}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => { throw new HttpError(503, "source_unavailable", `Source "${this.id}" is not reachable`); });
    if (!res.ok) upstreamError(this.id, res);
    return res;
  }

  async info(caller: Caller) {
    return sourceInfoSchema.parse(await (await this.call(caller, "")).json());
  }

  async query(caller: Caller, q: SourceQuery) {
    const res = await this.call(caller, "/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
    const parsed = pageSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new HttpError(502, "source_error", `Source "${this.id}" returned an invalid answer`);
    return parsed.data;
  }

  async fetch(caller: Caller, ref: string) {
    const res = await this.call(caller, `/items/${encodeURIComponent(ref)}/content`);
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename="([^"]*)"/.exec(cd);
    return { bytes: await readLimited(res, this.maxBytes), name: m ? decodeURIComponent(m[1]!) : ref };
  }
}

type DmsFile = { id: string; appId: string | null; name: string; contentType: string; size: number; metadata: Record<string, unknown>; createdAt: string };

/** The user's files already saved in Nevli-DMS. */
export class DmsSource implements DataSource {
  readonly id = "dms";
  constructor(private readonly dmsUrl: string, private readonly maxBytes: number) {}

  private async call(caller: Caller, path: string) {
    const res = await fetch(`${this.dmsUrl}${path}`, { headers: { authorization: `Bearer ${caller.credential}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .catch(() => { throw new HttpError(503, "source_unavailable", "The document store is not reachable"); });
    if (!res.ok) upstreamError(this.id, res);
    return res;
  }

  async info() {
    return { name: "Ilven documents", description: "Files saved in your Ilven document store (Nevli-DMS).", status: "ready" as const, experimental: false, filters: { text: true, dateRange: true, favorite: false } };
  }

  async query(caller: Caller, q: SourceQuery) {
    const p = new URLSearchParams({ limit: String(q.limit) });
    if (q.text) p.set("q", q.text);
    if (q.from) p.set("after", q.from);
    const before = q.cursor ?? q.to;
    if (before) p.set("before", before);
    const { files } = (await (await this.call(caller, `/dms/api/files?${p}`)).json()) as { files: DmsFile[] };
    const items = files.map((f) => ({
      ref: f.id,
      name: f.name,
      contentType: f.contentType,
      size: f.size,
      date: new Date(f.createdAt).toISOString(),
      description: [f.appId ? `from ${f.appId}` : null, typeof f.metadata?.prompt === "string" ? f.metadata.prompt : null].filter(Boolean).join(": ").slice(0, 1000) || undefined,
    }));
    return { items, cursor: files.length === q.limit ? items[items.length - 1]!.date : null };
  }

  async fetch(caller: Caller, ref: string) {
    if (!z.uuid().safeParse(ref).success) throw notFound("Not found in source \"dms\"");
    const meta = (await (await this.call(caller, `/dms/api/files/${ref}`)).json()) as DmsFile;
    return { bytes: await readLimited(await this.call(caller, `/dms/api/files/${ref}/content`), this.maxBytes), name: meta.name };
  }
}

export const sourceConfigSchema = z.array(
  z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/), url: z.url() }),
);

export class SourceRegistry {
  private readonly sources = new Map<string, DataSource>();
  constructor(list: DataSource[]) {
    for (const s of list) this.sources.set(s.id, s);
  }
  ids() { return [...this.sources.keys()]; }
  get(id: string): DataSource {
    const s = this.sources.get(id);
    if (!s) throw notFound(`Unknown data source "${id}"`);
    return s;
  }
  /** Every source with its description; unreachable sources are listed as unavailable rather than failing the list. */
  async list(caller: Caller) {
    return Promise.all(
      [...this.sources.values()].map(async (s) => {
        try {
          return { id: s.id, available: true, ...(await s.info(caller)) };
        } catch {
          return { id: s.id, available: false, name: s.id, description: "Currently unavailable", status: "ready" as const, experimental: false, filters: { text: false, dateRange: false, favorite: false } };
        }
      }),
    );
  }
}
