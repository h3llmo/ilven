import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db, Sealer } from "@ilven/common";

/**
 * Per-user envelope encryption.
 * Each user has a random 256-bit data key (DEK), stored sealed by the vault master key. Every blob and every piece of
 * sensitive metadata is AES-256-GCM encrypted with the user's DEK, bound (AAD) to the row it belongs to, so a
 * ciphertext can't be moved to another user, item or version.
 */
const MAGIC = Buffer.from("LVv1");

export class UserKey {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Invalid data key");
  }

  encrypt(plain: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): Buffer {
    if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("Invalid ciphertext");
    const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(4, 16));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([d.update(blob.subarray(32)), d.final()]);
  }

  sealJson(value: unknown, aad: string): string {
    return this.encrypt(Buffer.from(JSON.stringify(value)), aad).toString("base64");
  }

  openJson<T>(sealed: string, aad: string): T {
    return JSON.parse(this.decrypt(Buffer.from(sealed, "base64"), aad).toString("utf8")) as T;
  }
}

/** Loads (or creates on first use) the caller's data key. Only ever called for an authenticated caller's own `sub`. */
export async function userKey(db: Db, master: Sealer, sub: string): Promise<UserKey> {
  const existing = await db.query<{ sealed_key: string }>("SELECT sealed_key FROM vault_users WHERE owner_sub = $1", [sub]);
  if (existing.rows[0]) return new UserKey(Buffer.from(master.open(existing.rows[0].sealed_key), "hex"));
  const fresh = master.seal(randomBytes(32).toString("hex"));
  await db.query("INSERT INTO vault_users (owner_sub, sealed_key) VALUES ($1, $2) ON CONFLICT (owner_sub) DO NOTHING", [sub, fresh]);
  const { rows } = await db.query<{ sealed_key: string }>("SELECT sealed_key FROM vault_users WHERE owner_sub = $1", [sub]);
  return new UserKey(Buffer.from(master.open(rows[0]!.sealed_key), "hex"));
}
