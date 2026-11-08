import { randomUUID } from "node:crypto";
import { z } from "zod";
import { badRequest, forbidden, hmacHex, HttpError, notFound, type Caller, type Db, type Sealer } from "@ilven/common";
import { userKey } from "./crypto.ts";
import type { DataSource, SourceInfo, SourcePage, SourceQuery } from "./sources.ts";

/**
 * EXPERIMENTAL iCloud Photos source (sidecar `locke-vault-icloud`, pyicloud).
 * - Off for everyone by default: a user requests access, a vault admin (Ilven admin) approves it.
 * - Each user connects their own Apple account and chooses the album the vault reads (e.g. "Locke").
 * - The sidecar is only reachable by the vault (private network + token); the vault enforces access.
 */
export const ICLOUD_MIGRATION = {
  id: "002_experimental_icloud",
  sql: `
  CREATE TABLE experimental_access (
    id uuid PRIMARY KEY,
    owner_sub text NOT NULL,
    feature text NOT NULL,
    status text NOT NULL CHECK (status IN ('requested', 'granted', 'revoked')),
    sealed_name text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    UNIQUE (owner_sub, feature)
  );
  CREATE TABLE user_settings (owner_sub text NOT NULL, name text NOT NULL, sealed text NOT NULL, PRIMARY KEY (owner_sub, name));`,
};

const FEATURE = "icloud";
const aadSetting = (sub: string, name: string) => `setting:${sub}:${name}`;

/** Readable name for the admin's access list, taken from the (already verified) login token. Stored sealed. */
function displayName(caller: Caller): string {
  if (caller.kind !== "identity") return caller.sub;
  try {
    const p = JSON.parse(Buffer.from(caller.credential.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const n = [p.preferred_username, p.email, p.name].find((v) => typeof v === "string" && v);
    return (n as string | undefined)?.slice(0, 120) ?? caller.sub;
  } catch {
    return caller.sub;
  }
}

export class Icloud implements DataSource {
  readonly id = "icloud";
  constructor(
    private readonly db: Db,
    private readonly master: Sealer,
    private readonly masterHex: string,
    private readonly url: string,
    private readonly token: string,
    private readonly maxBytes: number,
  ) {}

  /** Opaque, per-deployment id for the sidecar: the sidecar never learns the user's login `sub`. */
  private uid(sub: string) {
    return hmacHex(this.masterHex, "locke-vault/icloud-user", sub);
  }

  private async sidecar(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "x-vault-token": this.token, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(120_000),
    }).catch(() => { throw new HttpError(503, "source_unavailable", "The iCloud connector is not running"); });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { detail?: { error?: string; message?: string }; error?: string; message?: string };
      const e = d.detail ?? d;
      const status = res.status === 409 ? 409 : res.status === 404 ? 404 : res.status === 401 || res.status === 403 || res.status === 400 || res.status === 413 ? res.status : 502;
      throw new HttpError(status, e.error ?? "icloud_error", e.message ?? `iCloud connector error (HTTP ${res.status})`);
    }
    return res;
  }

  // ----- access (request → admin decision) -----
  async access(sub: string): Promise<"none" | "requested" | "granted" | "revoked"> {
    const { rows } = await this.db.query<{ status: "requested" | "granted" | "revoked" }>("SELECT status FROM experimental_access WHERE owner_sub = $1 AND feature = $2", [sub, FEATURE]);
    return rows[0]?.status ?? "none";
  }

  private async requireAccess(caller: Caller) {
    if ((await this.access(caller.sub)) !== "granted") throw forbidden("iCloud Photos is an experimental source. Request access in the vault settings.");
  }

  async requestAccess(caller: Caller) {
    if (caller.kind !== "identity") throw forbidden("Request access from the vault itself");
    const current = await this.access(caller.sub);
    if (current === "granted" || current === "requested") return { access: current };
    if (current === "revoked") throw forbidden("Access was revoked by an administrator");
    await this.db.query("INSERT INTO experimental_access (id, owner_sub, feature, status, sealed_name) VALUES ($1, $2, $3, 'requested', $4)", [
      randomUUID(), caller.sub, FEATURE, this.master.seal(displayName(caller)),
    ]);
    return { access: "requested" as const };
  }

  async listAccess() {
    const { rows } = await this.db.query<{ id: string; status: string; sealed_name: string; requested_at: Date; decided_at: Date | null }>(
      "SELECT id, status, sealed_name, requested_at, decided_at FROM experimental_access WHERE feature = $1 ORDER BY requested_at DESC",
      [FEATURE],
    );
    return rows.map((r) => ({ id: r.id, user: this.master.open(r.sealed_name), status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at }));
  }

  /** granted / revoked, or removed (forget the request: the user may ask again). */
  async decide(id: string, status: "granted" | "revoked" | "removed") {
    if (!z.uuid().safeParse(id).success) throw notFound("Request not found");
    const { rows } = status === "removed"
      ? await this.db.query<{ owner_sub: string }>("DELETE FROM experimental_access WHERE id = $1 AND feature = $2 RETURNING owner_sub", [id, FEATURE])
      : await this.db.query<{ owner_sub: string }>(
        "UPDATE experimental_access SET status = $2, decided_at = now() WHERE id = $1 AND feature = $3 RETURNING owner_sub",
        [id, status, FEATURE],
      );
    if (!rows[0]) throw notFound("Request not found");
    // Revoking or removing also signs the user out of Apple and deletes their stored session.
    if (status !== "granted") await this.sidecar("/disconnect", { method: "POST", body: JSON.stringify({ user: this.uid(rows[0].owner_sub) }) }).catch(() => {});
    return { id, status };
  }

  // ----- per-user settings and Apple connection -----
  private async album(sub: string): Promise<string | null> {
    const { rows } = await this.db.query<{ sealed: string }>("SELECT sealed FROM user_settings WHERE owner_sub = $1 AND name = 'icloud_album'", [sub]);
    if (!rows[0]) return null;
    return (await userKey(this.db, this.master, sub)).openJson<string>(rows[0].sealed, aadSetting(sub, "icloud_album"));
  }

  async setAlbum(caller: Caller, album: string) {
    await this.requireAccess(caller);
    const key = await userKey(this.db, this.master, caller.sub);
    await this.db.query(
      `INSERT INTO user_settings (owner_sub, name, sealed) VALUES ($1, 'icloud_album', $2)
       ON CONFLICT (owner_sub, name) DO UPDATE SET sealed = EXCLUDED.sealed`,
      [caller.sub, key.sealJson(album, aadSetting(caller.sub, "icloud_album"))],
    );
    return this.status(caller);
  }

  async status(caller: Caller) {
    const access = await this.access(caller.sub);
    if (access !== "granted") return { access, connection: { state: "disconnected" as string, appleId: null as string | null, message: null as string | null }, album: null };
    const [conn, album] = await Promise.all([
      this.sidecar(`/status?user=${this.uid(caller.sub)}`).then((r) => r.json() as Promise<{ state: string; appleId?: string; message?: string }>).catch((e: Error) => ({ state: "unavailable", message: e.message })),
      this.album(caller.sub),
    ]);
    return { access, connection: { state: conn.state, appleId: ("appleId" in conn && conn.appleId) || null, message: conn.message ?? null }, album };
  }

  private requireInteractive(caller: Caller) {
    // Apple credentials are only ever typed by the user in the vault UI, never sent through an API key/connex.
    if (caller.kind !== "identity") throw forbidden("Connect iCloud from the vault settings page");
  }

  async connect(caller: Caller, appleId: string, password: string) {
    this.requireInteractive(caller);
    await this.requireAccess(caller);
    const r = await this.sidecar("/connect", { method: "POST", body: JSON.stringify({ user: this.uid(caller.sub), appleId, password }) });
    return r.json();
  }

  async verify(caller: Caller, code: string) {
    this.requireInteractive(caller);
    await this.requireAccess(caller);
    return (await this.sidecar("/verify", { method: "POST", body: JSON.stringify({ user: this.uid(caller.sub), code }) })).json();
  }

  async disconnect(caller: Caller) {
    // Always allowed, even after revocation: a user can remove their Apple session at any time.
    return (await this.sidecar("/disconnect", { method: "POST", body: JSON.stringify({ user: this.uid(caller.sub) }) })).json();
  }

  async albums(caller: Caller) {
    await this.requireAccess(caller);
    return (await this.sidecar(`/albums?user=${this.uid(caller.sub)}`)).json();
  }

  // ----- DataSource -----
  async info(caller: Caller): Promise<SourceInfo> {
    const base = { name: "iCloud Photos", experimental: true, filters: { text: true, dateRange: true, favorite: false, collection: false, addedAfter: false }, collections: [] };
    const access = await this.access(caller.sub);
    if (access !== "granted") return { ...base, description: "Experimental. Ask for access in Settings.", status: "not_allowed" };
    const album = await this.album(caller.sub);
    if (!album) return { ...base, description: "Choose your album in Settings.", status: "needs_setup" };
    const st = await this.status(caller);
    if (st.connection.state !== "connected") return { ...base, description: st.connection.message ?? "Connect your Apple account in Settings.", status: "needs_setup" };
    return { ...base, description: `Photos in your "${album}" album.`, status: "ready" };
  }

  private async ready(caller: Caller) {
    await this.requireAccess(caller);
    const album = await this.album(caller.sub);
    if (!album) throw new HttpError(409, "needs_setup", "Choose your iCloud album in the vault settings first");
    return album;
  }

  async query(caller: Caller, q: SourceQuery): Promise<SourcePage> {
    const album = await this.ready(caller);
    const r = await this.sidecar("/query", { method: "POST", body: JSON.stringify({ user: this.uid(caller.sub), album, text: q.text, from: q.from, to: q.to, limit: q.limit, cursor: q.cursor }) });
    return (await r.json()) as SourcePage;
  }

  async fetch(caller: Caller, ref: string) {
    const album = await this.ready(caller);
    if (ref.length > 300) throw badRequest("Invalid reference");
    const r = await this.sidecar(`/content?user=${this.uid(caller.sub)}&album=${encodeURIComponent(album)}&ref=${encodeURIComponent(ref)}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > this.maxBytes) throw new HttpError(413, "too_large", "This photo is too large");
    const m = /filename="([^"]*)"/.exec(r.headers.get("content-disposition") ?? "");
    return { bytes, name: m?.[1] ?? "photo.jpg" };
  }
}
