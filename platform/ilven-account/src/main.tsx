import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, initAuth, type IlvenAuth } from "@ilven/web-auth";
import "./style.css";

type Gender = "female" | "male" | "non_binary" | "other";
type Me = { registered: boolean; isAdmin: boolean; user?: { id: string; planId: string; profile: { birthYear: number | null; gender: Gender | null }; apiKey: { prefix: string; createdAt: string } | null } };
type Plan = { id: string; name: string; description: string };
type Connex = { appId: string; appName: string; presetName: string | null; allowedToolCount: number };
type Delegation = { id: string; appId: string; appName: string; purpose: string; audience: string[]; prefix: string; createdAt: string; lastUsedAt: string | null };

const GENDERS: { v: Gender; l: string }[] = [
  { v: "female", l: "Female" }, { v: "male", l: "Male" }, { v: "non_binary", l: "Non-binary" }, { v: "other", l: "Other" },
];
const thisYear = new Date().getFullYear();

/** Only same-origin return URLs are honoured (no open redirect). */
function returnUrl(): string | null {
  const r = new URLSearchParams(location.search).get("return");
  if (!r) return null;
  try {
    const u = new URL(r, location.origin);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}

function SharingFields(p: { age: boolean; setAge: (b: boolean) => void; year: string; setYear: (s: string) => void; gender: Gender | ""; setGender: (g: Gender | "") => void; shareGender: boolean; setShareGender: (b: boolean) => void }) {
  return (
    <>
      <p className="muted">Ilven only uses these to pick which assistant scope applies to you. Both are optional and off by default. Turning one off removes it from Ilven.</p>
      <label className="opt">
        <input type="checkbox" checked={p.age} onChange={(e) => p.setAge(e.target.checked)} />
        <span>
          <strong>Share my age with Ilven</strong>
          <br />
          {p.age && (
            <span className="row">
              Birth year{" "}
              <input type="number" min={thisYear - 120} max={thisYear} value={p.year} onChange={(e) => p.setYear(e.target.value)} required style={{ width: 110 }} aria-label="Birth year" />
              <span className="muted">Only the year is stored.</span>
            </span>
          )}
        </span>
      </label>
      <label className="opt">
        <input type="checkbox" checked={p.shareGender} onChange={(e) => p.setShareGender(e.target.checked)} />
        <span>
          <strong>Share my gender with Ilven</strong>
          <br />
          {p.shareGender && (
            <select value={p.gender} onChange={(e) => p.setGender(e.target.value as Gender)} required aria-label="Gender">
              <option value="" disabled>Choose…</option>
              {GENDERS.map((g) => <option key={g.v} value={g.v}>{g.l}</option>)}
            </select>
          )}
        </span>
      </label>
    </>
  );
}

function useSharing(initial?: { birthYear: number | null; gender: Gender | null }) {
  const [age, setAge] = useState(initial?.birthYear != null);
  const [year, setYear] = useState(initial?.birthYear?.toString() ?? "");
  const [shareGender, setShareGender] = useState(initial?.gender != null);
  const [gender, setGender] = useState<Gender | "">(initial?.gender ?? "");
  const value = { birthYear: age && year ? Number(year) : null, gender: shareGender && gender ? gender : null };
  return { fields: { age, setAge, year, setYear, shareGender, setShareGender, gender, setGender }, value };
}

function Register({ auth, onDone }: { auth: IlvenAuth; onDone: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState("free");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const s = useSharing();
  useEffect(() => { void api<Plan[]>(auth, "GET", "/nevli/api/plans").then(setPlans); }, [auth]);
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setErr("");
      try {
        await api(auth, "POST", "/nevli/api/me/register", { ...s.value, planId: plan });
        const r = returnUrl();
        if (r) location.href = r;
        else onDone();
      } catch (x) {
        setErr((x as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <h2>Create your Ilven account</h2>
      <p className="muted">Ilven gives the apps on this platform an assistant that can act for you, only within the scope an administrator allows.</p>
      <h3>Profile sharing</h3>
      <SharingFields {...s.fields} />
      <h3>Plan</h3>
      {plans.map((p) => (
        <label className="opt" key={p.id}>
          <input type="radio" name="plan" checked={plan === p.id} onChange={() => setPlan(p.id)} />
          <span><strong>{p.name}</strong><br /><span className="muted">{p.description}</span></span>
        </label>
      ))}
      {err && <p className="err">{err}</p>}
      <button disabled={busy}>Register</button>
    </form>
  );
}

function Settings({ auth, me, reload }: { auth: IlvenAuth; me: Me; reload: () => void }) {
  const u = me.user!;
  const s = useSharing(u.profile);
  const [msg, setMsg] = useState("");
  const [connexes, setConnexes] = useState<Connex[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const loadDelegations = () => void api<Delegation[]>(auth, "GET", "/nevli/api/me/delegations").then(setDelegations);
  useEffect(() => { void api<Connex[]>(auth, "GET", "/nevli/api/me/connexes").then(setConnexes); loadDelegations(); }, [auth, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = returnUrl();
  return (
    <>
      {r && <p><a href={r}>← Back to the app</a></p>}
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(auth, "PUT", "/nevli/api/me/profile", s.value);
          setMsg("Saved.");
          reload();
        } catch (x) { setMsg((x as Error).message); }
      }}>
        <h2>Profile sharing</h2>
        <SharingFields {...s.fields} />
        <div className="row"><button>Save</button><span className="ok">{msg}</span></div>
      </form>
      <section className="card">
        <h2>Your Ilven API key</h2>
        <p className="muted">Used automatically by your connexes so the assistant can act for you. You never need to copy it.</p>
        <p>{u.apiKey ? <>Active key <code>{u.apiKey.prefix}…</code> since {new Date(u.apiKey.createdAt).toLocaleDateString()}</> : <span className="err">No active key.</span>}</p>
        <button className="secondary" onClick={async () => {
          if (!confirm("Issue a new key? The current one stops working immediately.")) return;
          await api(auth, "POST", "/nevli/api/me/api-key/rotate");
          reload();
        }}>{u.apiKey ? "Rotate key" : "Issue key"}</button>
      </section>
      <section className="card">
        <h2>Your connexes</h2>
        <table><thead><tr><th>App</th><th>Assistant scope</th><th>Allowed actions</th></tr></thead>
          <tbody>{connexes.map((c) => <tr key={c.appId}><td>{c.appName}</td><td>{c.presetName ?? "—"}</td><td>{c.allowedToolCount || <span className="pill">none</span>}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="card">
        <h2>Apps acting for you while you're away</h2>
        <p className="muted">Keys you gave an app (for example Locke's automated workflows). Each works only at the services listed, never for the assistant. Revoking one stops that app's automations at once; the app asks again next time you turn them on.</p>
        {delegations.length === 0 ? <p className="muted">None.</p> : (
          <table><thead><tr><th>App</th><th>For</th><th>Can reach</th><th>Last used</th><th /></tr></thead>
            <tbody>{delegations.map((d) => (
              <tr key={d.id}>
                <td>{d.appName}</td><td>{d.purpose}</td><td>{d.audience.join(", ")}</td>
                <td>{d.lastUsedAt ? new Date(d.lastUsedAt).toLocaleString() : "never"}</td>
                <td><button className="secondary" onClick={async () => {
                  if (!confirm(`Revoke ${d.appName}'s access? Its automations stop until you allow it again.`)) return;
                  await api(auth, "DELETE", `/nevli/api/me/delegations/${d.id}`);
                  loadDelegations();
                }}>Revoke</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Delete Ilven account</h2>
        <p className="muted">Removes your Ilven user, API key, connexes, apps' access and shared profile data. Your login and your data inside apps are not affected.</p>
        <button className="danger" onClick={async () => {
          if (!confirm("Delete your Ilven account?")) return;
          await api(auth, "DELETE", "/nevli/api/me");
          reload();
        }}>Delete</button>
      </section>
    </>
  );
}

function App({ auth }: { auth: IlvenAuth }) {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<Me>(auth, "GET", "/nevli/api/me").then(setMe).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, []);
  return (
    <>
      <header className="top"><h1>Ilven Account</h1><span className="spacer" />{auth.name}<button className="link" onClick={() => void auth.logout()}>Sign out</button></header>
      <main>
        {err && <p className="err">{err}</p>}
        {me && (me.registered ? <Settings auth={auth} me={me} reload={load} /> : <Register auth={auth} onDone={load} />)}
      </main>
    </>
  );
}

const auth = await initAuth({ requireLogin: true });
createRoot(document.getElementById("root")!).render(<StrictMode><App auth={auth} /></StrictMode>);
