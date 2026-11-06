import type { FastifyInstance, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "./errors.ts";

export { McpServer };

/**
 * Mounts a stateless MCP endpoint (Streamable HTTP, JSON responses). A fresh server is built per request
 * so each request's tools run with that request's credential only.
 */
export function mountMcp(app: FastifyInstance, path: string, build: (req: FastifyRequest) => Promise<McpServer> | McpServer) {
  app.post(path, async (req, reply) => {
    const server = await build(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: FastifyRequest, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.get(path, notAllowed as never);
  app.delete(path, notAllowed as never);
}

/** Wraps a tool implementation: JSON result as text; errors become MCP tool errors without internal details. */
export async function toolResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : e instanceof Error && e.name === "ZodError" ? "Invalid input" : "The operation failed";
    if (!(e instanceof HttpError)) console.error("[mcp] tool error", e);
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}
