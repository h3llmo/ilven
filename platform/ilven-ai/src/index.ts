import { z } from "zod";
import { APICallError } from "ai";
import { createIdentityVerifier, createServer, env, HttpError, listen, secret, unauthorized } from "@ilven/common";
import { Confirmations } from "./confirm.ts";
import { runChat, type Preset } from "./core.ts";
import { connectConnex } from "./mcp-client.ts";
import { languageModel, type ProviderConfig } from "./providers.ts";

const NEVLI = env("NEVLI_INTERNAL_URL", "http://nevli:3001");
const internalToken = secret("ILVEN_INTERNAL_TOKEN");
const confirmations = new Confirmations(Buffer.from(secret("ILVEN_AI_CONFIRM_KEY"), "hex"));
const idp = createIdentityVerifier();

type Session =
  | { status: "not_registered" | "no_connex" | "ai_disabled" | "no_api_key" }
  | { status: "ok"; app: { id: string; name: string }; preset: Preset; mcpUrl: string; apiKey: string | null; provider: ProviderConfig };

async function loadSession(sub: string, appId: string, peek = false): Promise<Session> {
  const res = await fetch(`${NEVLI}/internal/ai/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ilven-internal-token": internalToken },
    body: JSON.stringify({ sub, appId, peek }),
  });
  if (!res.ok) throw new HttpError(502, "nevli_unavailable", "Nevli is unavailable");
  return (await res.json()) as Session;
}

const STATUS_REPLIES: Record<string, string> = {
  not_registered: "You need an Ilven account to use the assistant. Register in Ilven-Account, then come back.",
  no_connex: "This app is not connected to the Ilven assistant for your account.",
  ai_disabled: "The Ilven assistant is not enabled on this platform (no AI provider is configured). The app still works normally.",
  no_api_key: "Your Ilven API key is missing or revoked, so the assistant can't act for you. You can issue a new one in Ilven-Account.",
};

const chatBody = z.object({
  app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).min(1).max(40),
  pageContext: z.unknown().optional(),
  confirmation: z.string().max(1000).optional(),
});

const app = createServer({ bodyLimit: 512 * 1024 });

async function identify(req: Parameters<typeof idp.tokenFrom>[0]) {
  const t = idp.tokenFrom(req);
  if (!t) throw unauthorized();
  try {
    return await idp.verify(t);
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}

app.get("/ai/api/status", async (req) => {
  const id = await identify(req);
  const { app: appId } = z.object({ app: z.string().min(1) }).parse(req.query);
  const s = await loadSession(id.sub, appId, true);
  return {
    status: s.status,
    ...(s.status === "ok" ? { app: s.app, preset: { name: s.preset.name, allowedTools: s.preset.tools.length, conversation: s.preset.conversation } } : { message: STATUS_REPLIES[s.status] }),
  };
});

app.post("/ai/api/chat", async (req) => {
  const id = await identify(req);
  const body = chatBody.parse(req.body);
  const s = await loadSession(id.sub, body.app);
  if (s.status !== "ok") return { status: s.status, reply: STATUS_REPLIES[s.status], actions: [] };

  const caller = s.preset.tools.length ? await connectConnex(s.mcpUrl, s.apiKey) : { list: async () => [], call: async () => { throw new Error("unreachable"); }, close: async () => {} };
  try {
    const result = await runChat(s.app.name, s.preset, body, {
      model: languageModel(s.provider),
      guardModel: languageModel(s.provider, s.provider.guardModel),
      caller,
      confirmations,
      sub: id.sub,
      appId: s.app.id,
    });
    req.log.info({ app: s.app.id, preset: s.preset.name, conversation: s.preset.conversation, actions: result.actions.map((a) => `${a.tool}:${a.ok}`), refused: result.refused }, "chat turn");
    return { status: "ok", ...result };
  } catch (e) {
    if (APICallError.isInstance(e)) {
      req.log.warn({ provider: s.provider.id, status: e.statusCode }, "AI provider error");
      throw new HttpError(502, "provider_error", `The AI provider rejected the request${e.statusCode ? ` (HTTP ${e.statusCode})` : ""}.`);
    }
    throw e;
  } finally {
    await caller.close();
  }
});

await listen(app, 3000);
