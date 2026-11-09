import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env, envOptional } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { unauthorized } from "./errors.ts";

/** A user identified by the IdP. `sub` is the only stable user key. */
export interface Identity {
  sub: string;
  isAdmin: boolean;
}

/** Who is calling: a logged-in user (IdP token) or a connex acting with a user's Ilven API key. */
export type Caller =
  | { kind: "identity"; sub: string; isAdmin: boolean; credential: string }
  | { kind: "apiKey"; sub: string; userId: string; credential: string; delegatedTo?: string };

export const API_KEY_PREFIX = "ilv_";
export const isApiKey = (s: string) => s.startsWith(API_KEY_PREFIX);

type Verifier = (token: string) => Promise<Identity>;

/**
 * Builds the IdP token verifier from env.
 * - ILVEN_AUTH_MODE=oidc (dev, Keycloak): `Authorization: Bearer <access token>`.
 * - ILVEN_AUTH_MODE=cloudflare (prod): `Cf-Access-Jwt-Assertion` header injected by Cloudflare Access.
 */
export function createIdentityVerifier(): { mode: string; verify: Verifier; tokenFrom: (req: FastifyRequest) => string | undefined } {
  const mode = env("ILVEN_AUTH_MODE", "oidc");
  if (mode === "cloudflare") {
    const team = env("CF_ACCESS_TEAM_DOMAIN"); // e.g. https://myteam.cloudflareaccess.com
    const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    const aud = env("CF_ACCESS_AUD");
    const admins = new Set((envOptional("ILVEN_ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    return {
      mode,
      tokenFrom: (req) => (req.headers["cf-access-jwt-assertion"] as string | undefined) ?? bearer(req),
      verify: async (token) => {
        const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: aud });
        const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
        return { sub: requireSub(payload), isAdmin: admins.has(email) };
      },
    };
  }
  const issuer = env("OIDC_ISSUER");
  const jwks = createRemoteJWKSet(new URL(env("OIDC_JWKS_URL")));
  const audience = env("OIDC_AUDIENCE", "ilven");
  const adminRole = env("OIDC_ADMIN_ROLE", "ilven-admin");
  return {
    mode,
    tokenFrom: bearer,
    verify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      if (payload.typ !== undefined && payload.typ !== "Bearer") throw unauthorized("Not an access token");
      const roles = ((payload.realm_access as { roles?: unknown } | undefined)?.roles ?? []) as unknown[];
      return { sub: requireSub(payload), isAdmin: roles.includes(adminRole) };
    },
  };
}

function requireSub(p: JWTPayload): string {
  if (!p.sub) throw unauthorized("Token has no sub");
  return p.sub;
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * Verifies Ilven API keys against Nevli's internal endpoint. Results are cached briefly.
 * `service` names the verifying service: delegated keys (an app acting for a user while they're away) are only
 * accepted by the services in their audience. Without a name, a service accepts users' own API keys only.
 */
export function createApiKeyVerifier(nevliInternalUrl = env("NEVLI_INTERNAL_URL", "http://nevli:3001"), ttlMs = 30_000, service?: string) {
  type Verified = { userId: string; sub: string; delegatedTo?: string };
  const cache = new Map<string, { at: number; value: Verified | null }>();
  return async (key: string): Promise<Verified | null> => {
    const h = sha256Hex(key);
    const hit = cache.get(h);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const res = await fetch(`${nevliInternalUrl}/internal/api-keys/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(service ? { key, service } : { key }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`API key verification failed: HTTP ${res.status}`);
    const value = res.ok ? ((await res.json()) as Verified) : null;
    cache.set(h, { at: Date.now(), value });
    if (cache.size > 5000) cache.clear();
    return value;
  };
}

/**
 * Authenticates a request carrying either an IdP token or an Ilven API key.
 * Apps use this so the same resource checks apply to UI calls and to Ilven-AI calls through a connex.
 */
export function createCallerAuthenticator(opts: { allowApiKey: boolean; service?: string }) {
  const idp = createIdentityVerifier();
  const verifyKey = opts.allowApiKey ? createApiKeyVerifier(undefined, undefined, opts.service) : undefined;
  return async (req: FastifyRequest): Promise<Caller> => {
    const b = bearer(req);
    if (b && isApiKey(b)) {
      if (!verifyKey) throw unauthorized("API keys are not accepted here");
      const r = await verifyKey(b);
      if (!r) throw unauthorized("Invalid API key");
      return { kind: "apiKey", sub: r.sub, userId: r.userId, credential: b, ...(r.delegatedTo ? { delegatedTo: r.delegatedTo } : {}) };
    }
    const token = idp.tokenFrom(req);
    if (!token) throw unauthorized();
    try {
      const id = await idp.verify(token);
      return { kind: "identity", sub: id.sub, isAdmin: id.isAdmin, credential: token };
    } catch {
      throw unauthorized("Invalid or expired token");
    }
  };
}
