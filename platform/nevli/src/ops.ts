import { z } from "zod";
import { forbidden } from "@ilven/common";
import { GENDERS, type Actor, type Ctx } from "./context.ts";
import { listApps, refreshTools } from "./services/apps.ts";
import { listConnexes, syncConnexes } from "./services/connexes.ts";
import { listServices, restartService } from "./services/docker.ts";
import { issueApiKey, revokeApiKey } from "./services/keys.ts";
import { createCriterion, createPreset, deleteCriterion, deletePreset, getPreset, listCriteria, listPresets, updatePreset } from "./services/presets.ts";
import { PROVIDERS, deleteProvider, listProviders, setProviderKey, updateProvider } from "./services/providers.ts";
import { deleteUser, describeUser, listUsers, userById } from "./services/users.ts";

/**
 * Nevli admin operations. Each operation is defined ONCE and exposed both as a REST route
 * (under /nevli/api/admin) and as an MCP tool on Nevli's MCP server, so the two stay in sync by construction.
 * An operation with `mcp: false` is REST-only; the reason must be documented next to it.
 */
export interface Op<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  mcp?: boolean;
  run: (ctx: Ctx, input: z.infer<z.ZodObject<S>>, actor: Actor) => Promise<unknown>;
}

const op = <S extends z.ZodRawShape>(o: Op<S>) => o as unknown as Op;

const uuid = z.uuid();
const appId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).describe("App id, e.g. 'pilot'");
const toolNames = z.array(z.string().min(1).max(128)).max(200);
const gender = z.enum(GENDERS);
const provider = z.enum(PROVIDERS);

export const ops: Op[] = [
  // Users, plans, API keys
  op({ name: "list_users", title: "List users", description: "List Ilven users with their plan, shared profile attributes and API key status.", method: "GET", path: "/users", input: {}, readOnly: true, run: (ctx) => listUsers(ctx) }),
  op({ name: "get_user", title: "Get user", description: "Get one Ilven user.", method: "GET", path: "/users/:userId", input: { userId: uuid }, readOnly: true, run: async (ctx, i) => describeUser(ctx, await userById(ctx, i.userId)) }),
  op({
    name: "delete_user", title: "Delete user", description: "Delete an Ilven user, their API key and connexes. Does not touch the IdP account or app data.",
    method: "DELETE", path: "/users/:userId", input: { userId: uuid }, destructive: true,
    run: async (ctx, i) => { await deleteUser(ctx, i.userId); return { deleted: i.userId }; },
  }),
  op({
    name: "rotate_user_api_key", title: "Rotate API key", description: "Revoke the user's Ilven API key and issue a new one. Their connexes switch to the new key.",
    method: "POST", path: "/users/:userId/api-key/rotate", input: { userId: uuid }, destructive: true,
    run: async (ctx, i) => { await userById(ctx, i.userId); const k = await issueApiKey(ctx, i.userId); await syncConnexes(ctx, { userId: i.userId }); return { prefix: k.prefix }; },
  }),
  op({
    name: "revoke_user_api_key", title: "Revoke API key", description: "Revoke the user's Ilven API key. Ilven-AI can no longer act for them until a new key is issued.",
    method: "POST", path: "/users/:userId/api-key/revoke", input: { userId: uuid }, destructive: true,
    run: async (ctx, i) => ({ revoked: await revokeApiKey(ctx, i.userId) }),
  }),
  op({ name: "list_plans", title: "List plans", description: "List Ilven plans.", method: "GET", path: "/plans", input: {}, readOnly: true, run: async (ctx) => (await ctx.db.query("SELECT id, name, description FROM plans ORDER BY id")).rows }),

  // Apps and presets
  op({ name: "list_apps", title: "List apps", description: "List registered Ilven-Apps and the tools discovered on their MCP servers.", method: "GET", path: "/apps", input: {}, readOnly: true, run: (ctx) => listApps(ctx) }),
  op({ name: "refresh_app_tools", title: "Refresh app tools", description: "Re-list an app's tools from its MCP server.", method: "POST", path: "/apps/:appId/refresh", input: { appId }, run: (ctx, i) => refreshTools(ctx, i.appId) }),
  op({ name: "list_presets", title: "List presets", description: "List the presets of an app (allowed tools + rules for Ilven-AI).", method: "GET", path: "/apps/:appId/presets", input: { appId }, readOnly: true, run: (ctx, i) => listPresets(ctx, i.appId) }),
  op({ name: "get_preset", title: "Get preset", description: "Get one preset.", method: "GET", path: "/presets/:presetId", input: { presetId: uuid }, readOnly: true, run: (ctx, i) => getPreset(ctx, i.presetId) }),
  op({
    name: "create_preset", title: "Create preset", description: "Create a preset for an app. New presets allow nothing unless tools are listed.",
    method: "POST", path: "/apps/:appId/presets",
    input: { appId, name: z.string().min(1).max(80), tools: toolNames.default([]), rules: z.string().max(10_000).default("") },
    run: (ctx, i) => createPreset(ctx, i.appId, i),
  }),
  op({
    name: "update_preset", title: "Update preset", description: "Change a preset's name, allowed tools (replaces the whole list) or rules. Affected connexes are updated immediately.",
    method: "PATCH", path: "/presets/:presetId",
    input: { presetId: uuid, name: z.string().min(1).max(80).optional(), tools: toolNames.optional(), rules: z.string().max(10_000).optional() },
    run: (ctx, i) => updatePreset(ctx, i.presetId, i),
  }),
  op({ name: "delete_preset", title: "Delete preset", description: "Delete a non-default preset and its criteria. Users fall back to other criteria or the default preset.", method: "DELETE", path: "/presets/:presetId", input: { presetId: uuid }, destructive: true, run: (ctx, i) => deletePreset(ctx, i.presetId) }),
  op({ name: "list_preset_criteria", title: "List assignment criteria", description: "List an app's preset assignment criteria in priority order.", method: "GET", path: "/apps/:appId/criteria", input: { appId }, readOnly: true, run: (ctx, i) => listCriteria(ctx, i.appId) }),
  op({
    name: "create_preset_criterion", title: "Create assignment criterion",
    description: "Map users to a preset by shared profile attributes. Lower priority number = evaluated first; first match wins; users who did not share an attribute never match a criterion on it.",
    method: "POST", path: "/apps/:appId/criteria",
    input: { appId, presetId: uuid, priority: z.int().min(0).max(100_000), minAge: z.int().min(0).max(150).nullish(), maxAge: z.int().min(0).max(150).nullish(), gender: gender.nullish() },
    run: (ctx, i) => createCriterion(ctx, i.appId, i),
  }),
  op({ name: "delete_preset_criterion", title: "Delete assignment criterion", description: "Delete an assignment criterion.", method: "DELETE", path: "/criteria/:criterionId", input: { criterionId: uuid }, destructive: true, run: (ctx, i) => deleteCriterion(ctx, i.criterionId) }),
  op({
    name: "list_connexes", title: "List connexes", description: "List connexes (user × app) with their resolved preset.",
    method: "GET", path: "/connexes", input: { userId: uuid.optional(), appId: appId.optional() }, readOnly: true,
    run: (ctx, i) => listConnexes(ctx, i),
  }),
  op({ name: "resync_connexes", title: "Re-resolve connexes", description: "Re-resolve every connex from current profiles, presets and criteria.", method: "POST", path: "/connexes/resync", input: {}, run: async (ctx) => { await syncConnexes(ctx); return { ok: true }; } }),

  // Operator AI provider keys
  op({ name: "list_ai_providers", title: "List AI providers", description: "List AI providers powering Ilven-AI. Keys are never returned.", method: "GET", path: "/ai-providers", input: {}, readOnly: true, run: (ctx) => listProviders(ctx) }),
  op({
    // REST-only: an MCP tool taking a key would put the operator key into the LLM context, which §6 forbids.
    name: "set_ai_provider_key", title: "Set AI provider key", description: "Store (encrypted) an operator AI provider key.",
    method: "PUT", path: "/ai-providers/:provider/key", input: { provider, apiKey: z.string().min(8).max(500), model: z.string().min(1).max(100).optional() },
    mcp: false, run: async (ctx, i) => { await setProviderKey(ctx, i.provider, i.apiKey, i.model); return { ok: true }; },
  }),
  op({
    name: "update_ai_provider", title: "Update AI provider", description: "Change an AI provider's model, enabled flag or priority (lower = preferred).",
    method: "PATCH", path: "/ai-providers/:provider", input: { provider, model: z.string().min(1).max(100).optional(), enabled: z.boolean().optional(), priority: z.int().min(0).max(1000).optional() },
    run: async (ctx, i) => { await updateProvider(ctx, i.provider, i); return { ok: true }; },
  }),
  op({ name: "delete_ai_provider", title: "Delete AI provider", description: "Delete an AI provider key. If none remain, Ilven-AI is disabled.", method: "DELETE", path: "/ai-providers/:provider", input: { provider }, destructive: true, run: async (ctx, i) => { await deleteProvider(ctx, i.provider); return { ok: true }; } }),

  // Containers (requires the optional docker socket proxy)
  op({ name: "list_services", title: "List services", description: "List the containers of this Ilven compose project. Requires docker access granted by the host administrator.", method: "GET", path: "/services", input: {}, readOnly: true, run: (ctx) => listServices(ctx) }),
  op({ name: "restart_service", title: "Restart service", description: "Restart a compose service of this Ilven project, e.g. 'pilot' or 'nevli-dms'.", method: "POST", path: "/services/:service/restart", input: { service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/) }, destructive: true, run: (ctx, i) => restartService(ctx, i.service) }),
];

export function requireAdmin(actor: Actor) {
  if (!actor.isAdmin) throw forbidden("Admin role required");
}

export const mcpOps = () => ops.filter((o) => o.mcp !== false);
