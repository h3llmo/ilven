import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, initAuth, type IlvenAuth } from "@ilven/web-auth";
import "./style.css";

type Tool = { name: string; title?: string; description?: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } };
type App = { id: string; name: string; kind: string; tools: Tool[]; toolsError: string | null; toolsRefreshedAt: string | null };
type Scope = "actions" | "app" | "open";
type Preset = { id: string; name: string; isDefault: boolean; tools: string[]; rules: string; conversation: Scope; topics: string };
type Criterion = { id: string; presetId: string; presetName: string; priority: number; minAge: number | null; maxAge: number | null; gender: string | null };
type User = { id: string; sub: string; isAdmin: boolean; planId: string; profile: { birthYear: number | null; gender: string | null }; apiKey: { prefix: string } | null; createdAt: string };
type Connex = { id: string; sub: string; appName: string; presetName: string | null; allowedToolCount: number; hasApiKey: boolean; updatedAt: string };
type Provider = { id: string; configured: boolean; model: string; guardModel: string; enabled: boolean; priority: number | null };
type Service = { service: string; container: string; state: string; status: string };

const A = "/nevli/api/admin";
let auth: IlvenAuth;
const call = <T,>(m: string, u: string, b?: unknown) => api<T>(auth, m, A + u, b);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => fn().then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message)), deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, reload };
}

function PresetEditor({ app, preset, onChange }: { app: App; preset: Preset; onChange: () => void }) {
  const [tools, setTools] = useState(new Set(preset.tools));
  const [rules, setRules] = useState(preset.rules);
  const [name, setName] = useState(preset.name);
  const [conversation, setConversation] = useState<Scope>(preset.conversation);
  const [topics, setTopics] = useState(preset.topics);
  const [msg, setMsg] = useState("");
  const dirty = name !== preset.name || rules !== preset.rules || conversation !== preset.conversation || topics !== preset.topics || tools.size !== preset.tools.length || preset.tools.some((t) => !tools.has(t));
  const stale = preset.tools.filter((t) => !app.tools.some((x) => x.name === t));
  return (
    <div className="card">
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={preset.isDefault} aria-label="Preset name" />
        {preset.isDefault && <span className="pill">default</span>}
        <span className={`pill ${tools.size ? "good" : "warn"}`}>{tools.size ? `${tools.size} allowed` : "allows nothing"}</span>
      </div>
      <h3>Allowed tools</h3>
      <div className="tools">
        {app.tools.length === 0 && <p className="muted">No tools discovered on this app's MCP server.</p>}
        {app.tools.map((t) => (
          <label key={t.name}>
            <input type="checkbox" checked={tools.has(t.name)} onChange={(e) => { const s = new Set(tools); e.target.checked ? s.add(t.name) : s.delete(t.name); setTools(s); }} />
            <span><code>{t.name}</code> {t.annotations?.destructiveHint && <span className="pill warn">destructive · asks confirmation</span>}<small>{t.description}</small></span>
          </label>
        ))}
        {stale.length > 0 && <p className="muted">Allowed but no longer offered by the app: {stale.join(", ")}</p>}
      </div>
      <h3>Conversation scope</h3>
      <select value={conversation} onChange={(e) => setConversation(e.target.value as Scope)} aria-label="Conversation scope">
        <option value="actions">Actions only: requests the allowed tools can serve</option>
        <option value="app">App: also questions about this app and the topics below</option>
        <option value="open">Open: general assistant (uses your AI key for anything)</option>
      </select>
      {conversation !== "open" && <p className="muted">Every message is checked by the guard model first; anything out of scope is refused before the main model runs.</p>}
      {conversation === "app" && (
        <textarea value={topics} onChange={(e) => setTopics(e.target.value)} rows={2} style={{ width: "100%" }} placeholder="e.g. Pilot generates images from prompts; questions about prompts, sizes and styles." aria-label="Topics" />
      )}
      <h3>Rules for Ilven-AI</h3>
      <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} style={{ width: "100%" }} placeholder="e.g. Never generate more than one image per request." />
      <div className="row">
        <button disabled={!dirty} onClick={async () => {
          try { await call("PATCH", `/presets/${preset.id}`, { name: preset.isDefault ? undefined : name, tools: [...tools], rules, conversation, topics }); setMsg("Saved."); onChange(); } catch (e) { setMsg((e as Error).message); }
        }}>Save</button>
        {!preset.isDefault && <button className="danger" onClick={async () => { if (confirm(`Delete preset "${preset.name}"?`)) { await call("DELETE", `/presets/${preset.id}`); onChange(); } }}>Delete</button>}
        <span className="ok">{msg}</span>
      </div>
    </div>
  );
}

function Criteria({ app, presets }: { app: App; presets: Preset[] }) {
  const { data, err, reload } = useLoad(() => call<Criterion[]>("GET", `/apps/${app.id}/criteria`), [app.id, presets.length]);
  const [f, setF] = useState({ presetId: "", priority: "10", minAge: "", maxAge: "", gender: "" });
  const num = (s: string) => (s === "" ? null : Number(s));
  return (
    <div className="card">
      <h2>Assignment criteria</h2>
      <p className="muted">Evaluated by ascending priority; the first match wins. Users who didn't share an attribute never match a criterion on it. No match → default preset.</p>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>Priority</th><th>Age</th><th>Gender</th><th>Preset</th><th /></tr></thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}><td>{c.priority}</td><td>{c.minAge ?? "…"}–{c.maxAge ?? "…"}</td><td>{c.gender ?? "any"}</td><td>{c.presetName}</td>
              <td><button className="link" onClick={async () => { await call("DELETE", `/criteria/${c.id}`); void reload(); }}>remove</button></td></tr>
          ))}
          <tr>
            <td><input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} style={{ width: 70 }} aria-label="Priority" /></td>
            <td className="row"><input type="number" placeholder="min" value={f.minAge} onChange={(e) => setF({ ...f, minAge: e.target.value })} style={{ width: 64 }} aria-label="Min age" /><input type="number" placeholder="max" value={f.maxAge} onChange={(e) => setF({ ...f, maxAge: e.target.value })} style={{ width: 64 }} aria-label="Max age" /></td>
            <td><select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} aria-label="Gender"><option value="">any</option><option value="female">female</option><option value="male">male</option><option value="non_binary">non-binary</option><option value="other">other</option></select></td>
            <td><select value={f.presetId} onChange={(e) => setF({ ...f, presetId: e.target.value })} aria-label="Preset"><option value="">preset…</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
            <td><button disabled={!f.presetId} onClick={async () => {
              try { await call("POST", `/apps/${app.id}/criteria`, { presetId: f.presetId, priority: Number(f.priority), minAge: num(f.minAge), maxAge: num(f.maxAge), gender: f.gender || null }); void reload(); } catch (e) { alert((e as Error).message); }
            }}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Apps() {
  const apps = useLoad(() => call<App[]>("GET", "/apps"));
  const [sel, setSel] = useState<string>("");
  const app = apps.data?.find((a) => a.id === sel) ?? apps.data?.[0];
  const presets = useLoad(() => (app ? call<Preset[]>("GET", `/apps/${app.id}/presets`) : Promise.resolve([])), [app?.id]);
  const [newName, setNewName] = useState("");
  if (!app) return <p className="muted">{apps.err || "Loading…"}</p>;
  return (
    <>
      <div className="row">
        <select value={app.id} onChange={(e) => setSel(e.target.value)} aria-label="App">{apps.data!.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}</select>
        <button className="secondary" onClick={async () => { try { await call("POST", `/apps/${app.id}/refresh`); } catch (e) { alert((e as Error).message); } void apps.reload(); }}>Refresh tools</button>
        <span className="muted">{app.tools.length} tools{app.toolsError ? ` · last refresh failed: ${app.toolsError}` : ""}</span>
      </div>
      {presets.data?.map((p) => <PresetEditor key={p.id + p.tools.join() + p.rules} app={app} preset={p} onChange={presets.reload} />)}
      <div className="row card">
        <input placeholder="New preset name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button disabled={!newName} onClick={async () => { try { await call("POST", `/apps/${app.id}/presets`, { name: newName }); setNewName(""); void presets.reload(); } catch (e) { alert((e as Error).message); } }}>Create preset</button>
      </div>
      {presets.data && <Criteria app={app} presets={presets.data} />}
    </>
  );
}

function Users() {
  const { data, err, reload } = useLoad(() => call<User[]>("GET", "/users"));
  return (
    <div className="card">
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>sub</th><th>Admin</th><th>Plan</th><th>Shared</th><th>API key</th><th /></tr></thead>
        <tbody>{data?.map((u) => (
          <tr key={u.id}>
            <td><code>{u.sub.slice(0, 13)}…</code></td><td>{u.isAdmin ? "yes" : ""}</td><td>{u.planId}</td>
            <td>{[u.profile.birthYear != null && `born ${u.profile.birthYear}`, u.profile.gender].filter(Boolean).join(", ") || <span className="muted">nothing</span>}</td>
            <td>{u.apiKey ? <code>{u.apiKey.prefix}…</code> : <span className="pill warn">none</span>}</td>
            <td className="row">
              <button className="link" onClick={async () => { if (confirm("Rotate this user's API key?")) { await call("POST", `/users/${u.id}/api-key/rotate`); void reload(); } }}>rotate key</button>
              <button className="link" onClick={async () => { if (confirm("Revoke this user's API key?")) { await call("POST", `/users/${u.id}/api-key/revoke`); void reload(); } }}>revoke key</button>
              <button className="link" onClick={async () => { if (confirm("Delete this Ilven user?")) { await call("DELETE", `/users/${u.id}`); void reload(); } }}>delete</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Connexes() {
  const { data, err, reload } = useLoad(() => call<Connex[]>("GET", "/connexes"));
  return (
    <div className="card">
      <div className="row"><button className="secondary" onClick={async () => { await call("POST", "/connexes/resync"); void reload(); }}>Re-resolve all</button></div>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>User</th><th>App</th><th>Preset</th><th>Allowed</th><th>Key</th><th>Updated</th></tr></thead>
        <tbody>{data?.map((c) => (
          <tr key={c.id}><td><code>{c.sub.slice(0, 13)}…</code></td><td>{c.appName}</td><td>{c.presetName}</td><td>{c.allowedToolCount}</td><td>{c.hasApiKey ? "✓" : <span className="pill warn">none</span>}</td><td>{new Date(c.updatedAt).toLocaleString()}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ProviderRow({ p, reload }: { p: Provider; reload: () => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.model);
  const [guardModel, setGuardModel] = useState(p.guardModel);
  return (
    <tr>
      <td><strong>{p.id}</strong></td>
      <td>{p.configured ? <span className="pill good">key stored</span> : <span className="pill">not configured</span>}</td>
      <td><input value={model} onChange={(e) => setModel(e.target.value)} aria-label={`${p.id} model`} /></td>
      <td><input value={guardModel} onChange={(e) => setGuardModel(e.target.value)} aria-label={`${p.id} guard model`} /></td>
      <td><input type="password" autoComplete="off" placeholder={p.configured ? "replace key…" : "API key"} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${p.id} key`} /></td>
      <td className="row">
        <button disabled={!key && (!p.configured || (model === p.model && guardModel === p.guardModel))} onClick={async () => {
          try {
            if (key) await call("PUT", `/ai-providers/${p.id}/key`, { apiKey: key, model });
            if (p.configured || key) await call("PATCH", `/ai-providers/${p.id}`, { model, guardModel });
            setKey(""); reload();
          } catch (e) { alert((e as Error).message); }
        }}>Save</button>
        {p.configured && <button className="secondary" onClick={async () => { await call("PATCH", `/ai-providers/${p.id}`, { enabled: !p.enabled }); reload(); }}>{p.enabled ? "Disable" : "Enable"}</button>}
        {p.configured && <button className="link" onClick={async () => { if (confirm(`Delete the ${p.id} key?`)) { await call("DELETE", `/ai-providers/${p.id}`); reload(); } }}>delete</button>}
      </td>
    </tr>
  );
}

function Providers() {
  const { data, err, reload } = useLoad(() => call<Provider[]>("GET", "/ai-providers"));
  const on = data?.some((p) => p.configured && p.enabled);
  return (
    <div className="card">
      <p>Ilven-AI is <strong>{on ? "enabled" : "disabled"}</strong>. {on ? "The first enabled provider by priority is used." : "Add at least one provider key to enable it. Apps keep working without it."}</p>
      <p className="muted">Keys are encrypted by Nevli and never shown again, logged or given to the model.</p>
      {err && <p className="err">{err}</p>}
      <table><thead><tr><th>Provider</th><th>Status</th><th>Model</th><th>Guard model</th><th>Key</th><th /></tr></thead>
        <tbody>{data?.map((p) => <ProviderRow key={p.id + p.configured + p.enabled + p.model + p.guardModel} p={p} reload={reload} />)}</tbody>
      </table>
    </div>
  );
}

function Services() {
  const { data, err, reload } = useLoad(() => call<Service[]>("GET", "/services"));
  return (
    <div className="card">
      {err && <p className="muted">{err}</p>}
      {data && (
        <table><thead><tr><th>Service</th><th>State</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((s) => (
            <tr key={s.container}><td>{s.service}</td><td>{s.state}</td><td>{s.status}</td>
              <td><button className="link" onClick={async () => { if (confirm(`Restart ${s.service}?`)) { try { await call("POST", `/services/${s.service}/restart`); } catch (e) { alert((e as Error).message); } void reload(); } }}>restart</button></td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

const TABS = { apps: ["Apps & presets", Apps], users: ["Users", Users], connexes: ["Connexes", Connexes], ai: ["AI providers", Providers], services: ["Services", Services] } as const;

function Root({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<keyof typeof TABS>((location.hash.slice(1) as keyof typeof TABS) in TABS ? (location.hash.slice(1) as keyof typeof TABS) : "apps");
  const View = TABS[tab][1];
  return (
    <>
      <header className="top">
        <h1>Nevli</h1>
        <nav className="tabs">{Object.entries(TABS).map(([k, [label]]) => <button key={k} className={k === tab ? "on" : ""} onClick={() => { setTab(k as keyof typeof TABS); location.hash = k; }}>{label}</button>)}</nav>
        <span className="spacer" />{auth.name}<button className="link" onClick={() => void auth.logout()}>Sign out</button>
      </header>
      <main style={{ maxWidth: 1000 }}>{isAdmin ? <View /> : <p className="err">The Ilven admin role is required.</p>}</main>
    </>
  );
}

auth = await initAuth({ requireLogin: true });
const me = await api<{ isAdmin: boolean; registered: boolean }>(auth, "GET", "/nevli/api/me");
createRoot(document.getElementById("root")!).render(<StrictMode><Root isAdmin={me.isAdmin} /></StrictMode>);

// The Nevli assistant: operates Nevli through the admin's Nevli connex (only tools allowed in its preset).
if (me.isAdmin) {
  const s = document.createElement("script");
  s.type = "module";
  s.src = "/plugin/ilven-plugin.js";
  s.onload = () => {
    const el = document.createElement("ilven-assistant") as HTMLElement & { tokenProvider?: unknown; contextProvider?: unknown };
    el.setAttribute("app", "nevli");
    el.tokenProvider = () => auth.getToken();
    el.contextProvider = () => ({ view: location.hash.slice(1) || "apps" });
    document.body.append(el);
  };
  document.head.append(s);
}
