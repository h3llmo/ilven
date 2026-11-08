import { api, ApiError, initAuth, type IlvenAuth } from "@ilven/web-auth";

type Version = { n: number; parent: number | null; contentType: string; size: number; app: string; operation: string; note: string | null; createdAt: string };
type Item = {
  id: string; title: string; currentVersion: number; size: number; updatedAt: string;
  origin: { kind: "upload" } | { kind: "source"; source: string; ref: string; name: string };
  versions: Version[]; pushes: { version: number; dmsFileId: string; pushedAt: string }[];
};
type Source = {
  id: string; available: boolean; name: string; description: string; status: "ready" | "needs_setup" | "not_allowed"; experimental: boolean;
  filters: { text: boolean; dateRange: boolean; favorite: boolean; collection: boolean; addedAfter: boolean };
  collections: { id: string; name: string }[];
};
type SourceItem = { ref: string; name: string; contentType?: string; size?: number; date?: string; favorite?: boolean; description?: string };

const A = "/apps/locke-vault/api";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const auth: IlvenAuth = await initAuth({ requireLogin: true });
$("who").textContent = auth.name ?? "";
$("logout").onclick = () => void auth.logout();

const DISPLAYABLE = /^image\/(png|jpeg|gif|webp|avif)$/;
const fmt = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

// ---- Authenticated blob URLs (file bytes need the user's token, so <img src> can't fetch them directly) ----
const blobs = new Map<string, Promise<string | null>>();
function blobUrl(url: string) {
  if (!blobs.has(url)) {
    blobs.set(url, auth.fetch(url).then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null)).catch(() => null));
  }
  return blobs.get(url)!;
}
function preview(url: string, type: string | undefined, alt: string) {
  const box = el("div", { className: "thumb" });
  if (type && !DISPLAYABLE.test(type)) {
    box.textContent = type === "application/pdf" ? "PDF" : (type.split("/")[1] ?? "file").toUpperCase();
    return box;
  }
  const img = el("img", { alt, loading: "lazy" });
  void blobUrl(url).then((u) => { if (u) { box.replaceChildren(img); img.src = u; } else box.textContent = "No preview"; });
  box.textContent = "…";
  return box;
}

// ---- Tabs ----
type Tab = "staged" | "sources" | "settings";
function showTab(which: Tab) {
  for (const t of ["staged", "sources", "settings"] as Tab[]) {
    $(`tab${t[0]!.toUpperCase()}${t.slice(1)}`).setAttribute("aria-selected", String(which === t));
    $(t).hidden = which !== t;
  }
  if (which === "sources") void loadSources();
  if (which === "settings") void loadSettings();
}
$("tabStaged").onclick = () => showTab("staged");
$("tabSources").onclick = () => showTab("sources");
$("tabSettings").onclick = () => showTab("settings");
$("goSettings").onclick = () => showTab("settings");

// ---- Quota ----
async function loadQuota() {
  const q = await api<{ used: number; limit: number }>(auth, "GET", `${A}/quota`);
  const pct = Math.min(100, (q.used / q.limit) * 100);
  const fill = $("quotaFill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("full", pct > 90);
  $("quotaText").textContent = `${fmt(q.used)} / ${fmt(q.limit)}`;
}

// ---- Staged items ----
let items: Item[] = [];
let itemsCursor: string | null = null;

function itemTile(it: Item) {
  const v = it.versions[it.versions.length - 1]!;
  const thumb = preview(`${A}/items/${it.id}/versions/${v.n}/content`, v.contentType, it.title);
  thumb.onclick = () => openDetail(it.id);
  const badges = el("div");
  badges.append(el("span", { className: "badge", textContent: `v${it.currentVersion}` }));
  if (it.versions.length > 1) badges.append(el("span", { className: "badge", textContent: `${it.versions.length} versions` }));
  if (it.pushes.length) badges.append(el("span", { className: "badge saved", textContent: "saved" }));
  const origin = it.origin.kind === "source" ? `from ${it.origin.source}` : "uploaded";
  return el("div", { className: "tile" }, thumb, el("div", { className: "meta" },
    el("span", { className: "name", textContent: it.title, title: it.title }),
    badges,
    el("span", { className: "sub", textContent: `${origin} · ${fmt(it.size)} · ${when(it.updatedAt)}` })));
}

function renderItems() {
  const g = $("items");
  g.replaceChildren(...(items.length ? items.map(itemTile) : [el("p", { className: "empty", textContent: "Nothing staged yet. Upload a file or stage one from a source." })]));
  $("moreItems").hidden = !itemsCursor;
}

async function loadItems(more = false) {
  const url = `${A}/items?limit=48${more && itemsCursor ? `&cursor=${encodeURIComponent(itemsCursor)}` : ""}`;
  const r = await api<{ items: Item[]; cursor: string | null }>(auth, "GET", url);
  items = more ? [...items, ...r.items] : r.items;
  itemsCursor = r.cursor;
  renderItems();
}
$("moreItems").onclick = () => void loadItems(true);

$<HTMLInputElement>("upload").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  for (const [i, f] of files.entries()) {
    $("stagedStatus").textContent = `Uploading ${f.name}${files.length > 1 ? ` (${i + 1}/${files.length})` : ""}…`;
    const title = f.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Upload";
    const res = await auth.fetch(`${A}/items?title=${encodeURIComponent(title)}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      $("stagedStatus").textContent = `${f.name}: ${d.message ?? `HTTP ${res.status}`}`;
      await Promise.all([loadItems(), loadQuota()]);
      return;
    }
  }
  $("stagedStatus").textContent = files.length ? "Uploaded." : "";
  await Promise.all([loadItems(), loadQuota()]);
};

// ---- Item detail: versions, compare, save, trash ----
let current: Item | null = null;
let selectedN = 0;

function figure(it: Item, v: Version) {
  const url = `${A}/items/${it.id}/versions/${v.n}/content`;
  const fig = el("figure");
  const cap = el("figcaption", { textContent: `v${v.n} · ${v.app}/${v.operation}` });
  if (DISPLAYABLE.test(v.contentType)) {
    const img = el("img", { alt: `${it.title} v${v.n}` });
    void blobUrl(url).then((u) => u && (img.src = u));
    fig.append(img, cap);
  } else if (v.contentType === "application/pdf") {
    const frame = el("iframe", { title: `${it.title} v${v.n}` });
    frame.setAttribute("sandbox", "");
    void blobUrl(url).then((u) => u && (frame.src = u));
    fig.append(frame, cap);
  } else {
    fig.append(el("div", { className: "placeholder", textContent: `${v.contentType} can't be shown in the browser. Use Download.` }), cap);
  }
  return fig;
}

function renderDetail() {
  const it = current!;
  const v = it.versions.find((x) => x.n === selectedN) ?? it.versions[it.versions.length - 1]!;
  selectedN = v.n;
  $<HTMLInputElement>("dTitle").value = it.title;
  $("dOrigin").textContent = it.origin.kind === "source" ? `Staged from ${it.origin.source}: ${it.origin.name}` : "Uploaded";
  const compare = $<HTMLInputElement>("compare");
  const prev = it.versions.find((x) => x.n === v.parent) ?? it.versions.filter((x) => x.n < v.n).pop();
  compare.disabled = !prev;
  const viewer = $("viewer");
  viewer.replaceChildren(...(compare.checked && prev ? [figure(it, prev), figure(it, v)] : [figure(it, v)]));
  $("versions").replaceChildren(
    ...[...it.versions].reverse().map((x) =>
      el("li", { className: x.n === v.n ? "sel" : "", onclick: () => { selectedN = x.n; renderDetail(); } },
        `v${x.n} · ${x.app} / ${x.operation}`,
        el("small", { textContent: `${when(x.createdAt)} · ${fmt(x.size)}${x.note ? ` · ${x.note}` : ""}` })),
    ),
  );
  $<HTMLButtonElement>("dPush").textContent = `Save v${v.n} to documents`;
  $<HTMLButtonElement>("dTrashVersion").disabled = it.versions.length === 1;
  const last = it.versions[it.versions.length - 1]!;
  const undo = $<HTMLButtonElement>("dUndo");
  undo.disabled = it.versions.length === 1;
  undo.textContent = it.versions.length > 1 ? `Undo ${last.operation}` : "Undo last step";
  const dl = $<HTMLAnchorElement>("dDownload");
  dl.onclick = async (e) => {
    e.preventDefault();
    const u = await blobUrl(`${A}/items/${it.id}/versions/${v.n}/content`);
    if (!u) return;
    const a = el("a", { href: u, download: `${it.title}-v${v.n}` });
    a.click();
  };
  $("dPushes").textContent = it.pushes.length ? `Saved to documents: ${it.pushes.map((p) => `v${p.version} (${when(p.pushedAt)})`).join(", ")}` : "";
}

async function openDetail(id: string) {
  current = await api<Item>(auth, "GET", `${A}/items/${id}`);
  selectedN = current.currentVersion;
  $<HTMLInputElement>("compare").checked = false;
  $("dStatus").textContent = "";
  renderDetail();
  const d = $<HTMLDialogElement>("detail");
  if (!d.open) d.showModal();
}

async function refreshDetail(msg: string) {
  current = await api<Item>(auth, "GET", `${A}/items/${current!.id}`);
  renderDetail();
  $("dStatus").textContent = msg;
  await Promise.all([loadItems(), loadQuota()]);
}

async function act(fn: () => Promise<void>) {
  try { await fn(); } catch (e) { $("dStatus").textContent = errMsg(e); }
}
$<HTMLInputElement>("compare").onchange = () => renderDetail();
$("dRename").onclick = () => act(async () => {
  await api(auth, "PATCH", `${A}/items/${current!.id}`, { title: $<HTMLInputElement>("dTitle").value });
  await refreshDetail("Renamed.");
});
$("dPush").onclick = () => act(async () => {
  $("dStatus").textContent = "Saving…";
  await api(auth, "POST", `${A}/items/${current!.id}/push`, { version: selectedN });
  await refreshDetail(`v${selectedN} saved to your documents. It stays staged until you trash it.`);
});
$("dTrashVersion").onclick = () => act(async () => {
  if (!confirm(`Permanently delete version ${selectedN}?`)) return;
  current = await api<Item>(auth, "DELETE", `${A}/items/${current!.id}/versions/${selectedN}`);
  selectedN = current.currentVersion;
  await refreshDetail("Version trashed.");
});
// Rollback: remove the latest version (named explicitly, so a version added meanwhile is never the one removed).
$("dUndo").onclick = () => act(async () => {
  const last = current!.versions[current!.versions.length - 1]!;
  if (!confirm(`Undo "${last.operation}" (v${last.n})? That version is deleted and v${current!.versions[current!.versions.length - 2]!.n} becomes the current one.`)) return;
  current = await api<Item>(auth, "DELETE", `${A}/items/${current!.id}/versions/${last.n}`);
  selectedN = current.currentVersion;
  await refreshDetail(`Rolled back to v${current.currentVersion}.`);
});
$("dTrash").onclick = () => act(async () => {
  const saved = current!.pushes.length ? " Copies saved to your documents are kept." : " It was never saved to your documents.";
  if (!confirm(`Permanently delete "${current!.title}" and all its versions?${saved}`)) return;
  await api(auth, "DELETE", `${A}/items/${current!.id}`);
  $<HTMLDialogElement>("detail").close();
  await Promise.all([loadItems(), loadQuota()]);
});

// ---- Sources (read-only search, preview, stage) ----
let sources: Source[] = [];
let results: SourceItem[] = [];
let resultsCursor: string | null = null;
const selectedSource = () => sources.find((s) => s.id === $<HTMLSelectElement>("sourceSelect").value);

async function loadSources() {
  const keep = $<HTMLSelectElement>("sourceSelect").value;
  sources = (await api<{ sources: Source[] }>(auth, "GET", `${A}/sources`)).sources;
  const label = (s: Source) => `${s.name}${s.experimental ? " (experimental)" : ""}${!s.available ? " (unavailable)" : s.status === "not_allowed" ? " (not enabled)" : s.status === "needs_setup" ? " (needs setup)" : ""}`;
  $("sourceSelect").replaceChildren(...sources.map((s) => el("option", { value: s.id, textContent: label(s), disabled: !s.available })));
  const pick = sources.find((s) => s.id === keep && s.available) ?? sources.find((s) => s.available && s.status === "ready");
  if (pick) $<HTMLSelectElement>("sourceSelect").value = pick.id;
  onSourceChange();
}

function onSourceChange() {
  const s = selectedSource();
  $("sourceInfo").textContent = s?.description ?? "";
  $("searchText").hidden = !s?.filters.text;
  for (const id of ["searchFrom", "searchTo"]) $(id).parentElement!.hidden = !s?.filters.dateRange;
  $("favWrap").hidden = !s?.filters.favorite;
  const coll = $<HTMLSelectElement>("searchCollection");
  const showColl = !!s?.filters.collection && s.collections.length > 0;
  coll.hidden = !showColl;
  coll.replaceChildren(el("option", { value: "", textContent: "All" }), ...(showColl ? s!.collections.map((c) => el("option", { value: c.id, textContent: c.name })) : []));
  $("sourceSetup").hidden = !s || s.status === "ready";
  results = [];
  resultsCursor = null;
  renderResults();
  if (s?.available && s.status === "ready") void search();
}
$("sourceSelect").onchange = onSourceChange;
$("searchCollection").onchange = () => void search();

function resultTile(s: Source, r: SourceItem) {
  const url = `${A}/sources/${encodeURIComponent(s.id)}/items/${encodeURIComponent(r.ref)}/content`;
  const btn = el("button", { textContent: "Stage" });
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Staging…";
    try {
      await api(auth, "POST", `${A}/items/from-source`, { source: s.id, ref: r.ref });
      btn.textContent = "Staged ✓";
      await Promise.all([loadItems(), loadQuota()]);
    } catch (e) {
      btn.textContent = "Stage";
      btn.disabled = false;
      alert(errMsg(e));
    }
  };
  const sub = [r.date ? when(r.date) : null, r.size ? fmt(r.size) : null, r.description ?? null].filter(Boolean).join(" · ");
  return el("div", { className: "tile" }, preview(url, r.contentType, r.name),
    el("div", { className: "meta" }, el("span", { className: "name", textContent: r.name, title: r.name }), el("span", { className: "sub", textContent: sub, title: r.description ?? "" }), btn));
}

function renderResults() {
  const s = selectedSource();
  $("results").replaceChildren(...(s && results.length ? results.map((r) => resultTile(s, r)) : [el("p", { className: "empty", textContent: s?.available === false ? "This source is unavailable." : "No files found." })]));
  $("moreResults").hidden = !resultsCursor;
}

async function search(more = false) {
  const s = selectedSource();
  if (!s) return;
  const day = (id: string, end: boolean) => {
    const v = $<HTMLInputElement>(id).value;
    return v ? new Date(`${v}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : undefined;
  };
  const q = {
    text: s.filters.text ? $<HTMLInputElement>("searchText").value.trim() || undefined : undefined,
    from: s.filters.dateRange ? day("searchFrom", false) : undefined,
    to: s.filters.dateRange ? day("searchTo", true) : undefined,
    favorite: s.filters.favorite && $<HTMLInputElement>("searchFav").checked ? true : undefined,
    collection: s.filters.collection ? $<HTMLSelectElement>("searchCollection").value || undefined : undefined,
    limit: 30,
    cursor: more ? resultsCursor ?? undefined : undefined,
  };
  try {
    const r = await api<{ items: SourceItem[]; cursor: string | null }>(auth, "POST", `${A}/sources/${encodeURIComponent(s.id)}/query`, q);
    results = more ? [...results, ...r.items] : r.items;
    resultsCursor = r.cursor;
    renderResults();
  } catch (e) {
    // Show the error in place of the results; never a stale "No files found" / "Load more" next to it.
    if (!more) { results = []; resultsCursor = null; }
    $("moreResults").hidden = !resultsCursor;
    if (!more) $("results").replaceChildren(el("p", { className: "empty", textContent: errMsg(e) }));
    else $("sourceInfo").textContent = errMsg(e);
  }
}
$("searchForm").onsubmit = (e) => { e.preventDefault(); void search(); };
$("moreResults").onclick = () => void search(true);

// ---- Settings: experimental iCloud source (per user) and admin approvals ----
type IcStatus = { access: "none" | "requested" | "granted" | "revoked"; connection: { state: string; appleId: string | null; message: string | null }; album: string | null };
const X = `${A}/experimental/icloud`;
const icMsg = (m: string) => ($("icMsg").textContent = m);

async function loadSettings() {
  const me = await api<{ isAdmin: boolean; experimental: { icloud: string } }>(auth, "GET", `${A}/me`);
  $("adminCard").hidden = !me.isAdmin;
  if (me.isAdmin) void loadAdmin();
  if (me.experimental.icloud === "unavailable") {
    $("icAccess").replaceChildren(el("p", { className: "muted", textContent: "The iCloud connector is not installed on this server." }));
    $("icConnect").hidden = true;
    return;
  }
  const st = await api<IcStatus>(auth, "GET", X);
  const access = $("icAccess");
  $("icConnect").hidden = st.access !== "granted";
  if (st.access === "none") {
    const b = el("button", { textContent: "Request access" });
    b.onclick = async () => { await api(auth, "POST", `${X}/request-access`); await loadSettings(); };
    access.replaceChildren(b);
  } else if (st.access === "requested") access.replaceChildren(el("p", { className: "notice", textContent: "Access requested. An administrator needs to approve it." }));
  else if (st.access === "revoked") access.replaceChildren(el("p", { className: "notice", textContent: "Access was revoked by an administrator." }));
  else access.replaceChildren(el("p", { className: "muted", textContent: "✓ You have access to this experimental source." }));
  if (st.access !== "granted") return;

  const c = st.connection;
  const states: Record<string, string> = {
    connected: `✓ Connected as ${c.appleId ?? "your Apple ID"}.`,
    needs_2fa: "Enter the 6-digit code Apple just sent to your trusted device.",
    expired: c.message ?? "Your Apple session expired. Connect again.",
    disconnected: "Not connected.",
    unavailable: c.message ?? "The iCloud connector is not reachable right now.",
  };
  $("icState").textContent = states[c.state] ?? c.state;
  $("icLogin").hidden = !["disconnected", "expired"].includes(c.state);
  $("ic2fa").hidden = c.state !== "needs_2fa";
  $("icDisconnect").hidden = !["connected", "needs_2fa", "expired"].includes(c.state);
  $<HTMLInputElement>("icAlbum").value = st.album ?? "";
  if (c.state === "connected") {
    api<{ albums: string[] }>(auth, "GET", `${X}/albums`)
      .then((r) => $("icAlbums").replaceChildren(...r.albums.map((a) => el("option", { value: a }))))
      .catch(() => {});
  }
}

$("icLogin").onsubmit = async (e) => {
  e.preventDefault();
  const pw = $<HTMLInputElement>("icPassword");
  icMsg("Signing in to Apple…");
  try {
    const r = await api<{ state: string }>(auth, "POST", `${X}/connect`, { appleId: $<HTMLInputElement>("icAppleId").value, password: pw.value });
    icMsg(r.state === "needs_2fa" ? "Apple sent a code to your trusted device." : "Connected.");
  } catch (err) { icMsg(errMsg(err)); } finally { pw.value = ""; }
  await loadSettings();
};
$("ic2fa").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(auth, "POST", `${X}/verify`, { code: $<HTMLInputElement>("icCode").value });
    $<HTMLInputElement>("icCode").value = "";
    icMsg("Connected.");
  } catch (err) { icMsg(errMsg(err)); }
  await loadSettings();
};
$("icDisconnect").onclick = async () => {
  if (!confirm("Disconnect your Apple account? The stored Apple session is deleted.")) return;
  await api(auth, "POST", `${X}/disconnect`);
  icMsg("Disconnected.");
  await loadSettings();
};
$("icAlbumForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(auth, "PUT", `${X}/album`, { album: $<HTMLInputElement>("icAlbum").value });
    icMsg("Album saved. Find its photos in Sources → iCloud Photos.");
  } catch (err) { icMsg(errMsg(err)); }
};

async function loadAdmin() {
  const r = await api<{ icloud: { id: string; user: string; status: string; requestedAt: string }[] }>(auth, "GET", `${A}/admin/experimental`);
  const list = $("adminList");
  if (!r.icloud.length) { list.replaceChildren(el("p", { className: "muted", textContent: "No requests yet." })); return; }
  list.replaceChildren(...r.icloud.map((q) => {
    const row = el("div", { className: "req" }, el("span", { textContent: `${q.user} · ${q.status} · ${when(q.requestedAt)}` }));
    const decide = (status: "granted" | "revoked" | "removed", text: string, cls = "") => {
      const b = el("button", { textContent: text, className: cls });
      b.onclick = async () => {
        if (status === "revoked" && !confirm(`Revoke iCloud access for ${q.user}? Their Apple session is deleted.`)) return;
        await api(auth, "POST", `${A}/admin/experimental/${q.id}`, { status });
        await loadAdmin();
      };
      return b;
    };
    if (q.status !== "granted") row.append(decide("granted", "Approve"));
    if (q.status !== "revoked") row.append(decide("revoked", "Revoke", "secondary danger"));
    else row.append(decide("removed", "Remove", "secondary"));
    return row;
  }));
}

// ---- Optional Ilven assistant (the vault works fully without it) ----
async function setupIlven() {
  try {
    const me = await api<{ registered: boolean }>(auth, "GET", "/nevli/api/me");
    if (!me.registered) {
      const b = $("banner");
      b.replaceChildren("Want an assistant here? ", el("a", { href: `/account/?return=${encodeURIComponent(location.href)}`, textContent: "Register with Ilven" }), ".");
      b.hidden = false;
    }
  } catch { /* Ilven not available */ }
  const script = el("script", { type: "module", src: "/plugin/ilven-plugin.js" });
  script.onload = () => {
    const a = document.createElement("ilven-assistant") as HTMLElement & { tokenProvider?: unknown; contextProvider?: unknown };
    a.setAttribute("app", "locke-vault");
    a.tokenProvider = () => auth.getToken();
    a.contextProvider = () => ({
      view: !$("sources").hidden ? "sources" : !$("settings").hidden ? "settings" : "staged",
      openItem: current && $<HTMLDialogElement>("detail").open ? { id: current.id, title: current.title, selectedVersion: selectedN } : null,
      visibleItems: items.slice(0, 20).map((i) => ({ id: i.id, title: i.title, versions: i.versions.length })),
      source: $("sources").hidden ? null : selectedSource()?.id ?? null,
    });
    a.addEventListener("ilven:actions", () => { void loadItems(); void loadQuota(); });
    document.body.append(a);
  };
  document.head.append(script);
}

await Promise.all([loadItems(), loadQuota()]);
void setupIlven();
