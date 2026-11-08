import { createHmac } from "node:crypto";
import { conflict, envOptional, secret } from "@ilven/common";
import type { Ctx } from "../context.ts";

/**
 * Object storage for apps (Garage, S3-compatible). Nevli is the only holder of Garage's admin token: a registered
 * app asks for its storage with its app secret and gets one private bucket plus an S3 key limited to that bucket.
 * Keys are derived from Nevli's master key, so nothing extra is stored and repeated calls return the same key.
 */
export interface AppStorage {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface GarageConfig { adminUrl: string; adminToken: string; s3Url: string; region: string; capacity: number }

export function garageConfig(): GarageConfig | null {
  const adminUrl = envOptional("GARAGE_ADMIN_URL");
  if (!adminUrl) return null;
  return {
    adminUrl,
    adminToken: secret("GARAGE_ADMIN_TOKEN"),
    s3Url: envOptional("GARAGE_S3_URL") ?? "http://garage:3900",
    region: envOptional("GARAGE_REGION") ?? "garage",
    capacity: Number(envOptional("GARAGE_CAPACITY_BYTES") ?? 20 * 1024 ** 3),
  };
}

export class StorageUnavailable extends Error {}

async function admin<T>(g: GarageConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(`${g.adminUrl}/v2/${path}`, {
      method,
      headers: { authorization: `Bearer ${g.adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new StorageUnavailable(`Object storage unreachable: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T;
  if (res.status >= 500) throw new StorageUnavailable(`Object storage error: HTTP ${res.status}`);
  return { status: res.status, data };
}

/** Single-node deployment: give the node a role once, so buckets can be created. Idempotent. */
export async function ensureLayout(g: GarageConfig) {
  const { data } = await admin<{ layoutVersion: number; nodes: { id: string; role: unknown }[] }>(g, "GET", "GetClusterStatus");
  if (data.nodes.length && data.nodes.every((n) => n.role)) return;
  const roles = data.nodes.filter((n) => !n.role).map((n) => ({ id: n.id, zone: "local", capacity: g.capacity, tags: [] }));
  const staged = await admin(g, "POST", "UpdateClusterLayout", { roles });
  if (staged.status !== 200) throw new StorageUnavailable("Could not stage the storage layout");
  const applied = await admin(g, "POST", "ApplyClusterLayout", { version: data.layoutVersion + 1 });
  if (applied.status !== 200) throw new StorageUnavailable("Could not apply the storage layout");
}

/** Bucket name and S3 key for an app, derived from the master key (stable, never stored). */
export function appStorageKeys(masterKey: string, appId: string) {
  const derive = (label: string) => createHmac("sha256", Buffer.from(masterKey, "hex")).update(`ilven/storage/${label}\0${appId}`).digest("hex");
  return { bucket: `app-${appId}`, accessKeyId: `GK${derive("key-id").slice(0, 24)}`, secretAccessKey: derive("key-secret") };
}

export async function provisionAppStorage(ctx: Ctx, g: GarageConfig, appId: string): Promise<AppStorage> {
  await ensureLayout(g);
  const k = appStorageKeys(ctx.masterKey, appId);
  const imported = await admin<{ code?: string }>(g, "POST", "ImportKey", { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, name: `app-${appId}` });
  if (imported.status !== 200 && imported.data.code !== "KeyAlreadyExists") throw conflict("Could not create the app's storage key");
  let bucket = await admin<{ id?: string }>(g, "GET", `GetBucketInfo?globalAlias=${encodeURIComponent(k.bucket)}`);
  if (bucket.status === 404) bucket = await admin<{ id?: string }>(g, "POST", "CreateBucket", { globalAlias: k.bucket });
  if (bucket.status !== 200 || !bucket.data.id) throw conflict("Could not create the app's bucket");
  const allowed = await admin(g, "POST", "AllowBucketKey", {
    bucketId: bucket.data.id,
    accessKeyId: k.accessKeyId,
    permissions: { read: true, write: true, owner: false },
  });
  if (allowed.status !== 200) throw conflict("Could not grant the app access to its bucket");
  return { endpoint: g.s3Url, region: g.region, ...k };
}
