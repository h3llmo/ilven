import { z } from "zod";
import { ops } from "./ops.ts";

/** OpenAPI 3.1 document generated from the operation registry. */
export function buildOpenApi(prefix: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of ops) {
    const p = `${prefix}/admin${o.path.replace(/:(\w+)/g, "{$1}")}`;
    const pathParams = [...o.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const schema = z.toJSONSchema(z.object(o.input)) as { properties?: Record<string, unknown>; required?: string[] };
    const props = schema.properties ?? {};
    const parameters = pathParams.map((name) => ({ name, in: "path", required: true, schema: props[name] }));
    const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k)));
    const required = (schema.required ?? []).filter((k) => !pathParams.includes(k));
    const op: Record<string, unknown> = {
      operationId: o.name,
      summary: o.title,
      description: o.description + (o.mcp === false ? " (REST only.)" : " (Also exposed as the MCP tool of the same name.)"),
      parameters,
      responses: { "200": { description: "OK" } },
      security: [{ bearer: [] }],
    };
    if (Object.keys(rest).length) {
      if (o.method === "GET" || o.method === "DELETE")
        (op.parameters as unknown[]).push(...Object.entries(rest).map(([name, s]) => ({ name, in: "query", required: required.includes(name), schema: s })));
      else op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", properties: rest, required } } } };
    }
    (paths[p] ??= {})[o.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Nevli admin API", version: "0.1.0" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}
