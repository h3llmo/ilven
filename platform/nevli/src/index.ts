import { createDb, createServer, env, envOptional, listen, migrate, retry, Sealer, secret } from "@ilven/common";
import type { Ctx } from "./context.ts";
import { migrations } from "./migrations.ts";
import { registerPublicApi } from "./api.ts";
import { registerInternalApi, nevliTools } from "./internal.ts";
import { registerApp } from "./services/apps.ts";

const masterKey = secret("NEVLI_MASTER_KEY");
const db = createDb();
const ctx: Ctx = {
  db,
  sealer: new Sealer(masterKey),
  masterKey,
  projectName: env("COMPOSE_PROJECT", "ilven"),
  dockerHost: envOptional("DOCKER_HOST"),
};

await retry("database", () => db.query("SELECT 1"));
await migrate(db, migrations);

// Nevli is itself an Ilven-App (platform kind): admins get a connex to it for the Nevli-Web assistant.
await registerApp(ctx, { id: "nevli", name: "Nevli", kind: "platform", mcpUrl: env("NEVLI_MCP_URL", "http://nevli:3001/mcp") }, nevliTools());

const pub = createServer();
registerPublicApi(pub, ctx);
const internal = createServer();
registerInternalApi(internal, ctx, secret("ILVEN_INTERNAL_TOKEN"));

await listen(pub, 3000);
await listen(internal, 3001);
