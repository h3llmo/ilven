import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, "bad_request", m);
export const unauthorized = (m = "Authentication required") => new HttpError(401, "unauthorized", m);
export const forbidden = (m = "Forbidden") => new HttpError(403, "forbidden", m);
export const notFound = (m = "Not found") => new HttpError(404, "not_found", m);
export const conflict = (m: string) => new HttpError(409, "conflict", m);

/** Uniform JSON errors. Internal error details are logged, never returned. */
export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: "validation_error", message: "Invalid input", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal_error", message: "Internal error" });
  });
}
