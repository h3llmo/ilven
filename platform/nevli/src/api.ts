import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createIdentityVerifier, forbidden, notFound, unauthorized, type Identity } from "@ilven/common";
import { GENDERS, type Actor, type Ctx } from "./context.ts";
import { ops, requireAdmin, type Op } from "./ops.ts";
import { listConnexes } from "./services/connexes.ts";
import { issueApiKey } from "./services/keys.ts";
import { listDelegations, revokeDelegation } from "./services/delegations.ts";
import { describeUser, registerUser, syncAdminFlag, updateProfile, userBySub, deleteUser } from "./services/users.ts";
import { buildOpenApi } from "./openapi.ts";

const PREFIX = "/nevli/api";

const profileSchema = {
  birthYear: z.int().nullable().describe("Shared only if the user opted in to share their age; null = not shared"),
  gender: z.enum(GENDERS).nullable().describe("Shared only if the user opted in to share their gender; null = not shared"),
};

/** Public API (behind the gateway). Authenticated with the user's IdP token. */
export function registerPublicApi(app: FastifyInstance, ctx: Ctx) {
  const idp = createIdentityVerifier();
  const identify = async (req: Parameters<typeof idp.tokenFrom>[0]): Promise<Identity> => {
    const t = idp.tokenFrom(req);
    if (!t) throw unauthorized();
    try {
      return await idp.verify(t);
    } catch {
      throw unauthorized("Invalid or expired token");
    }
  };
  const registered = async (id: Identity) => {
    const u = await userBySub(ctx, id.sub);
    if (!u) throw notFound("Not registered with Ilven");
    await syncAdminFlag(ctx, u, id.isAdmin);
    return u;
  };

  app.get(`${PREFIX}/openapi.json`, async () => buildOpenApi(PREFIX));
  // Public directory of integrated apps (names and URLs only), for the landing page.
  app.get(`${PREFIX}/apps`, async () => (await ctx.db.query(`SELECT id, name, base_url AS "baseUrl" FROM apps WHERE kind = 'integration' ORDER BY name`)).rows);
  app.get(`${PREFIX}/plans`, async () => (await ctx.db.query("SELECT id, name, description FROM plans ORDER BY id")).rows);

  // --- Self-service (Ilven-Account) ---
  app.get(`${PREFIX}/me`, async (req) => {
    const id = await identify(req);
    const u = await userBySub(ctx, id.sub);
    if (!u) return { registered: false, isAdmin: id.isAdmin };
    await syncAdminFlag(ctx, u, id.isAdmin);
    return { registered: true, isAdmin: id.isAdmin, user: await describeUser(ctx, u) };
  });

  app.post(`${PREFIX}/me/register`, async (req, reply) => {
    const id = await identify(req);
    const body = z.object({ ...profileSchema, planId: z.string().min(1) }).parse(req.body);
    const u = await registerUser(ctx, id.sub, id.isAdmin, body);
    return reply.status(201).send({ registered: true, user: await describeUser(ctx, u) });
  });

  app.put(`${PREFIX}/me/profile`, async (req) => {
    const u = await registered(await identify(req));
    const body = z.object(profileSchema).parse(req.body);
    await updateProfile(ctx, u.id, body);
    return { ok: true };
  });

  app.post(`${PREFIX}/me/api-key/rotate`, async (req) => {
    const u = await registered(await identify(req));
    const k = await issueApiKey(ctx, u.id);
    return { prefix: k.prefix };
  });

  // Apps acting for the user while they're away (delegated keys). The user can revoke any of them.
  app.get(`${PREFIX}/me/delegations`, async (req) => {
    const u = await registered(await identify(req));
    return listDelegations(ctx, u.id);
  });
  app.delete(`${PREFIX}/me/delegations/:id`, async (req) => {
    const u = await registered(await identify(req));
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await revokeDelegation(ctx, u.id, id))) throw notFound("No such app access");
    return { revoked: true };
  });

  app.get(`${PREFIX}/me/connexes`, async (req) => {
    const u = await registered(await identify(req));
    return listConnexes(ctx, { userId: u.id });
  });

  app.delete(`${PREFIX}/me`, async (req) => {
    const u = await registered(await identify(req));
    await deleteUser(ctx, u.id);
    return { deleted: true };
  });

  // --- Admin operations (same definitions as the MCP tools) ---
  for (const o of ops) {
    app.route({
      method: o.method,
      url: `${PREFIX}/admin${o.path}`,
      handler: async (req) => {
        const id = await identify(req);
        if (!id.isAdmin) throw forbidden("Admin role required");
        const actor: Actor = { sub: id.sub, isAdmin: true, via: "rest" };
        requireAdmin(actor);
        const raw = { ...(req.query as object), ...((req.body as object) ?? {}), ...(req.params as object) };
        return o.run(ctx, parseInput(o, raw), actor);
      },
    });
  }
}

export function parseInput(o: Op, raw: unknown) {
  return z.object(o.input).strict().parse(raw);
}
