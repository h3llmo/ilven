import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolInfo, ToolCaller } from "./core.ts";

/** MCP client for one connex: the app's MCP server, authenticated with the user's Ilven API key. */
export async function connectConnex(mcpUrl: string, apiKey: string | null): Promise<ToolCaller> {
  const client = new Client({ name: "ilven-ai", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  await client.connect(transport);
  return {
    async list() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const t of page.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations });
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    async call(name, args) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
