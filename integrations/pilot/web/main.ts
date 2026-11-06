import { api, initAuth, type IlvenAuth } from "@ilven/web-auth";

type Image = { id: string; name: string; prompt: string | null; createdAt: string };
const API = "/apps/pilot/api";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const auth: IlvenAuth = await initAuth({ requireLogin: true });
$("who").textContent = auth.name ?? "";
$("logout").onclick = () => void auth.logout();

let images: Image[] = [];
let selected: string | null = null;
const urls = new Map<string, string>();

// ---- Settings (Pilot's own business: the user's OpenAI key) ----
async function loadSettings() {
  const s = await api<{ hasOpenAiKey: boolean }>(auth, "GET", `${API}/settings`);
  $("keyStatus").textContent = s.hasOpenAiKey ? "✓ A key is stored." : "No key stored yet.";
  $("keyDelete").hidden = !s.hasOpenAiKey;
}
$("keyForm").onsubmit = async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("keyInput");
  try {
    await api(auth, "PUT", `${API}/settings/openai-key`, { apiKey: input.value.trim() });
    input.value = "";
  } catch (err) { alert((err as Error).message); }
  await loadSettings();
};
$("keyDelete").onclick = async () => {
  if (!confirm("Remove your OpenAI key from Pilot?")) return;
  await api(auth, "DELETE", `${API}/settings/openai-key`);
  await loadSettings();
};

// ---- Generation (works without the assistant) ----
$("genForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("genBtn");
  btn.disabled = true;
  $("genStatus").textContent = "Generating… this can take a little while.";
  try {
    const img = await api<Image>(auth, "POST", `${API}/images`, { prompt: $<HTMLInputElement>("prompt").value, size: $<HTMLSelectElement>("size").value });
    $("genStatus").textContent = "Done.";
    selected = img.id;
    await loadGallery();
  } catch (err) {
    $("genStatus").textContent = (err as Error).message;
  } finally {
    btn.disabled = false;
  }
};

// ---- Gallery ----
async function imageUrl(id: string) {
  if (!urls.has(id)) {
    const res = await auth.fetch(`${API}/images/${id}/content`);
    urls.set(id, res.ok ? URL.createObjectURL(await res.blob()) : "");
  }
  return urls.get(id)!;
}

async function loadGallery() {
  images = (await api<{ images: Image[] }>(auth, "GET", `${API}/images`)).images;
  const g = $("gallery");
  g.replaceChildren();
  if (!images.length) g.innerHTML = `<p class="empty">No images yet.</p>`;
  for (const im of images) {
    const tile = document.createElement("div");
    tile.className = `tile${im.id === selected ? " sel" : ""}`;
    tile.dataset.id = im.id;
    const img = document.createElement("img");
    img.alt = im.prompt ?? im.name;
    void imageUrl(im.id).then((u) => (img.src = u));
    const cap = document.createElement("div");
    cap.className = "cap";
    const text = document.createElement("span");
    text.textContent = im.prompt ?? im.name;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("Delete this image?")) return;
      await api(auth, "DELETE", `${API}/images/${im.id}`);
      await loadGallery();
    };
    cap.append(text, del);
    tile.append(img, cap);
    tile.onclick = () => { selected = selected === im.id ? null : im.id; void loadGallery(); };
    g.append(tile);
  }
}

// ---- Optional Ilven assistant (Pilot works fully without it) ----
async function setupIlven() {
  try {
    const me = await api<{ registered: boolean }>(auth, "GET", "/nevli/api/me");
    if (!me.registered) {
      const b = $("banner");
      b.innerHTML = `Want an assistant here? <a href="/account/?return=${encodeURIComponent(location.href)}">Register with Ilven</a>.`;
      b.hidden = false;
    }
  } catch { /* Ilven not available: nothing to show */ }
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/plugin/ilven-plugin.js";
  script.onload = () => {
    const el = document.createElement("ilven-assistant") as HTMLElement & { tokenProvider?: unknown; contextProvider?: unknown };
    el.setAttribute("app", "pilot");
    el.tokenProvider = () => auth.getToken();
    el.contextProvider = () => ({
      view: "gallery",
      selectedImage: images.find((i) => i.id === selected) ?? null,
      visibleImages: images.slice(0, 20).map((i) => ({ id: i.id, prompt: i.prompt })),
    });
    el.addEventListener("ilven:actions", () => { void loadSettings(); void loadGallery(); });
    document.body.append(el);
  };
  document.head.append(script);
}

await Promise.all([loadSettings(), loadGallery()]);
void setupIlven();
