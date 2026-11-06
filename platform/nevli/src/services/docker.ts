import { HttpError, notFound } from "@ilven/common";
import type { Ctx } from "../context.ts";

/**
 * Container management through the OPTIONAL docker socket proxy (compose.docker.yaml).
 * Every call is filtered to containers labelled with this compose project.
 */
function base(ctx: Ctx): string {
  if (!ctx.dockerHost) throw new HttpError(503, "docker_unavailable", "Container management is not enabled: the host administrator has not granted docker.sock access.");
  return ctx.dockerHost.replace(/^tcp:\/\//, "http://").replace(/\/$/, "");
}

interface DContainer { Id: string; Names: string[]; State: string; Status: string; Image: string; Labels: Record<string, string> }

async function projectContainers(ctx: Ctx): Promise<DContainer[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${ctx.projectName}`] }));
  const res = await fetch(`${base(ctx)}/containers/json?all=1&filters=${filters}`);
  if (!res.ok) throw new HttpError(502, "docker_error", `Docker API error: HTTP ${res.status}`);
  const list = (await res.json()) as DContainer[];
  // Defense in depth: re-check the label even though the proxy query filtered on it.
  return list.filter((c) => c.Labels?.["com.docker.compose.project"] === ctx.projectName);
}

export async function listServices(ctx: Ctx) {
  return (await projectContainers(ctx)).map((c) => ({
    service: c.Labels["com.docker.compose.service"],
    container: c.Names[0]?.replace(/^\//, ""),
    state: c.State,
    status: c.Status,
    image: c.Image,
  }));
}

export async function restartService(ctx: Ctx, service: string) {
  const matches = (await projectContainers(ctx)).filter((c) => c.Labels["com.docker.compose.service"] === service);
  if (!matches.length) throw notFound(`No container for service "${service}" in project ${ctx.projectName}`);
  for (const c of matches) {
    const res = await fetch(`${base(ctx)}/containers/${c.Id}/restart?t=10`, { method: "POST" });
    if (!res.ok && res.status !== 204) throw new HttpError(502, "docker_error", `Restart failed: HTTP ${res.status}`);
  }
  return { service, restarted: matches.length };
}
