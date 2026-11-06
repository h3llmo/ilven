import { UserManager, WebStorageStateStore } from "oidc-client-ts";

/**
 * Shared browser auth for Ilven front-ends.
 * Runtime config comes from the gateway (/ilven-config.json), so the same build works in dev (Keycloak OIDC)
 * and prod (Cloudflare Access, where the edge handles login and injects the identity header).
 */
export interface IlvenConfig { authMode: "oidc" | "cloudflare"; issuer: string; clientId: string }
export interface IlvenAuth {
  mode: IlvenConfig["authMode"];
  loggedIn: boolean;
  name: string | null;
  getToken(): Promise<string | null>;
  login(): Promise<void>;
  logout(): Promise<void>;
  /** fetch with the user's credential; JSON helpers below. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function initAuth(opts: { requireLogin?: boolean } = {}): Promise<IlvenAuth> {
  const cfg = (await (await fetch("/ilven-config.json")).json()) as IlvenConfig;
  if (cfg.authMode === "cloudflare") {
    const auth: IlvenAuth = {
      mode: "cloudflare",
      loggedIn: true,
      name: null,
      getToken: async () => null,
      login: async () => location.reload(),
      logout: async () => { location.href = "/cdn-cgi/access/logout"; },
      fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
    };
    return auth;
  }

  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  const mgr = new UserManager({
    authority: cfg.issuer,
    client_id: cfg.clientId,
    redirect_uri: base,
    post_logout_redirect_uri: base,
    response_type: "code",
    scope: "openid profile",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });

  const params = new URLSearchParams(location.search);
  if (params.has("code") && params.has("state")) {
    const u = await mgr.signinRedirectCallback();
    const back = typeof u.state === "string" && u.state.startsWith(location.origin) ? u.state : base;
    history.replaceState(null, "", back);
  }

  let user = await mgr.getUser();
  if (user?.expired) user = await mgr.signinSilent().catch(() => null);
  mgr.events.addUserLoaded((u) => { user = u; });

  const login = () => mgr.signinRedirect({ state: location.href });
  if (!user && opts.requireLogin) {
    await login();
    await new Promise(() => {}); // navigating away
  }

  const getToken = async () => {
    if (user && user.expired) user = await mgr.signinSilent().catch(() => null);
    return user?.access_token ?? null;
  };

  return {
    mode: "oidc",
    loggedIn: !!user,
    name: (user?.profile.preferred_username as string | undefined) ?? (user?.profile.name as string | undefined) ?? null,
    getToken,
    login,
    logout: () => mgr.signoutRedirect(),
    fetch: async (input, init = {}) => {
      const t = await getToken();
      const headers = new Headers(init.headers);
      if (t) headers.set("authorization", `Bearer ${t}`);
      return fetch(input, { ...init, headers });
    },
  };
}

/** JSON request helper: throws ApiError with the server's message on failure. */
export async function api<T>(auth: IlvenAuth, method: string, url: string, body?: unknown): Promise<T> {
  const res = await auth.fetch(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `HTTP ${res.status}`);
  return data as T;
}
