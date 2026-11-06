import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { installErrorHandler } from "./errors.ts";

/** Fastify instance with secret-safe logging and uniform errors. */
export function createServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"cf-access-jwt-assertion\"]", "req.headers[\"x-ilven-internal-token\"]", "*.apiKey", "*.api_key", "*.password", "*.token"],
        censor: "[redacted]",
      },
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    ...opts,
  });
  installErrorHandler(app);
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

export async function listen(app: FastifyInstance, port: number) {
  await app.listen({ host: "0.0.0.0", port });
}

/** Retry an async operation with linear backoff (used for startup dependencies). */
export async function retry<T>(what: string, fn: () => Promise<T>, attempts = 60, delayMs = 2000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`[retry] ${what} failed (${i + 1}/${attempts}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}
