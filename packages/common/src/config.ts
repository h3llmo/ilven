import { readFileSync } from "node:fs";

/** Read a required env var. */
export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function envOptional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}

/**
 * Read a secret from the file named by `${name}_FILE` (preferred) or from `${name}`.
 * Secrets are generated inside the stack by an init container and shared through a Docker volume.
 */
export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return env(name);
}
