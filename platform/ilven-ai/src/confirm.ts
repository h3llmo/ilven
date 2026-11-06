import { createHmac, randomUUID } from "node:crypto";
import { safeEqual } from "@ilven/common";

export interface ConfirmTarget { sub: string; appId: string; tool: string; args: unknown }

/** Stable JSON (sorted keys) so the same arguments always produce the same digest. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Signed, single-use confirmation tokens for destructive tool calls.
 * A token authorises exactly one (user, app, tool, arguments) action for a few minutes.
 */
export class Confirmations {
  private used = new Map<string, number>();
  constructor(private key: Buffer, private ttlMs = 10 * 60_000) {}

  private digest(t: ConfirmTarget) {
    return createHmac("sha256", this.key).update(`${t.sub}\0${t.appId}\0${t.tool}\0${canonical(t.args)}`).digest("base64url");
  }
  private sign(payload: string) {
    return createHmac("sha256", this.key).update(`token\0${payload}`).digest("base64url");
  }

  issue(t: ConfirmTarget): string {
    const payload = Buffer.from(JSON.stringify({ d: this.digest(t), exp: Date.now() + this.ttlMs, jti: randomUUID() })).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** True (and the token is burnt) only if the token is authentic, unexpired, unused and matches this exact action. */
  consume(token: string | undefined, t: ConfirmTarget): boolean {
    if (!token) return false;
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEqual(sig, this.sign(payload))) return false;
    let p: { d: string; exp: number; jti: string };
    try {
      p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    if (p.exp < Date.now() || this.used.has(p.jti) || !safeEqual(p.d, this.digest(t))) return false;
    this.used.set(p.jti, p.exp);
    for (const [k, exp] of this.used) if (exp < Date.now()) this.used.delete(k);
    return true;
  }
}

/** Conservative check that the user's latest message is an explicit confirmation. False negatives just re-ask. */
export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  return /^(yes|y|yep|yeah|ok|okay|sure|confirm|confirmed|i confirm|go ahead|do it|proceed|please do|yes please|yes,? (do it|go ahead|proceed|delete it|please)|oui|d'accord|vas-y|je confirme)$/.test(t);
}
