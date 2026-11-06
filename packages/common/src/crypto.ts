import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM authenticated encryption. Key: 64 hex chars (32 bytes). Output: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export class Sealer {
  private key: Buffer;
  constructor(hexKey: string) {
    // Derive a dedicated encryption key so the master key is never used directly.
    this.key = createHmac("sha256", Buffer.from(hexKey, "hex")).update("ilven/seal/v1").digest();
  }
  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }
  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Invalid sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hmacHex(hexKey: string, label: string, data: string): string {
  return createHmac("sha256", Buffer.from(hexKey, "hex")).update(label).update("\0").update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
