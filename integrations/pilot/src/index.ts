import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { createCallerAuthenticator, createDb, createServer, env, listen, migrate, retry, Sealer, secret, unauthorized } from "@ilven/common";
import { mountMcp, McpServer, toolResult } from "@ilven/common/mcp";
import { deleteImage, deleteOpenAiKey, generateImage, hasOpenAiKey, imageContent, listImages, setOpenAiKey, SIZES, type PilotCtx } from "./pilot.ts";

const PREFIX = "/apps/pilot";
const db = createDb();
const ctx: PilotCtx = { db, sealer: new Sealer(secret("PILOT_MASTER_KEY")), dmsUrl: env("DMS_URL", "http://nevli-dms:3000"), openaiModel: env("PILOT_OPENAI_IMAGE_MODEL", "gpt-image-2.5-sunburst") };

await retry("database", () => db.query("SELECT 1"));
await migrate(db, [
  { id: "001_settings", sql: `CREATE TABLE settings (owner_sub text PRIMARY KEY, sealed_openai_key text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` },
]);

// ---------- Public app: UI + REST (conventional calls, user's IdP token) ----------
const web = createServer();
const authUser = createCallerAuthenticator({ allowApiKey: false });
const promptSchema = z.object({ prompt: z.string().min(1).max(4000), size: z.enum(SIZES).default("1024x1024") });

web.get(`${PREFIX}/api/settings`, async (req) => ({ hasOpenAiKey: await hasOpenAiKey(ctx, (await authUser(req)).sub) }));
web.put(`${PREFIX}/api/settings/openai-key`, async (req) => {
  const c = await authUser(req);
  const { apiKey } = z.object({ apiKey: z.string().min(20).max(300) }).parse(req.body);
  await setOpenAiKey(ctx, c.sub, apiKey);
  return { ok: true };
});
web.delete(`${PREFIX}/api/settings/openai-key`, async (req) => {
  await deleteOpenAiKey(ctx, (await authUser(req)).sub);
  return { ok: true };
});
web.post(`${PREFIX}/api/images`, async (req) => {
  const c = await authUser(req);
  const b = promptSchema.parse(req.body);
  return generateImage(ctx, c, b.prompt, b.size);
});
web.get(`${PREFIX}/api/images`, async (req) => ({ images: await listImages(ctx, await authUser(req)) }));
web.get(`${PREFIX}/api/images/:id/content`, async (req, reply) => {
  const r = await imageContent(ctx, await authUser(req), (req.params as { id: string }).id);
  reply.header("content-type", r.headers.get("content-type") ?? "application/octet-stream").header("cache-control", "private, max-age=300");
  return reply.send(Readable.fromWeb(r.body as never));
});
web.delete(`${PREFIX}/api/images/:id`, async (req) => deleteImage(ctx, await authUser(req), (req.params as { id: string }).id));

const here = dirname(fileURLToPath(import.meta.url));
web.register(fastifyStatic, { root: join(here, "web"), prefix: `${PREFIX}/`, index: "index.html" });
web.get(PREFIX, (_req, reply) => reply.redirect(`${PREFIX}/`));

// ---------- MCP server for Ilven-AI (internal network only, user's Ilven API key) ----------
const mcp = createServer();
const authKey = createCallerAuthenticator({ allowApiKey: true });
mountMcp(mcp, "/mcp", async (req) => {
  // Listing tools needs no credential (Nevli discovery). Every call needs a valid Ilven API key.
  const caller = req.headers.authorization ? await authKey(req).catch(() => null) : null;
  const need = () => {
    if (!caller || caller.kind !== "apiKey") throw unauthorized("An Ilven API key is required");
    return caller;
  };
  const s = new McpServer({ name: "pilot", version: "0.1.0" });
  s.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description: "Generate an image from a text prompt with the user's own OpenAI key and save it to their Pilot gallery. Pick a sensible size if the user doesn't say.",
      inputSchema: { prompt: z.string().min(1).max(4000).describe("What to draw"), size: z.enum(SIZES).default("1024x1024").describe("1024x1024 square, 1536x1024 landscape, 1024x1536 portrait") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, size }) => toolResult(() => generateImage(ctx, need(), prompt, size)),
  );
  s.registerTool(
    "list_images",
    { title: "List images", description: "List the user's previously generated Pilot images, newest first, with their prompts.", inputSchema: { limit: z.int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } },
    async ({ limit }) => toolResult(() => listImages(ctx, need(), limit)),
  );
  s.registerTool(
    "delete_image",
    { title: "Delete image", description: "Permanently delete one of the user's Pilot images.", inputSchema: { id: z.uuid().describe("Image id") }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async ({ id }) => toolResult(() => deleteImage(ctx, need(), id)),
  );
  s.registerTool(
    "check_setup",
    { title: "Check setup", description: "Whether the user has stored their OpenAI API key in Pilot (required to generate images).", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult(async () => ({ hasOpenAiKey: await hasOpenAiKey(ctx, need().sub) })),
  );
  return s;
});

await listen(web, 8080);
await listen(mcp, 8081);

// ---------- Register with Nevli (in the background; Pilot works without Ilven) ----------
const nevli = env("NEVLI_INTERNAL_URL", "http://nevli:3001");
const appSecret = readFileSync(env("PILOT_APP_SECRET_FILE"), "utf8").trim();
void retry("register with Nevli", async () => {
  const res = await fetch(`${nevli}/internal/apps/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "pilot", name: "Pilot", mcpUrl: env("PILOT_MCP_URL", "http://app-pilot:8081/mcp"), baseUrl: `${PREFIX}/`, secret: appSecret }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log("[pilot] registered with Nevli");
}, 1000, 3000).catch((e) => console.error("[pilot] registration with Nevli failed", e));
