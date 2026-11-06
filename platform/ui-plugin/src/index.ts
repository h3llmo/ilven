/**
 * <ilven-assistant app="pilot"> — embeddable Ilven assistant (Ilven-UI-Plugin).
 *
 * Integration (by the host app's developer):
 *   el.tokenProvider = () => Promise<string | null>   // the user's IdP access token (omit under Cloudflare Access)
 *   el.contextProvider = () => object                 // page context: current view, selected ids, visible state
 *   elements with data-ilven-context='{"..."}' are also collected automatically
 *   el.addEventListener("ilven:actions", e => ...)   // tool calls Ilven-AI performed; refresh your UI
 *
 * The plugin never calls the app's backend for the AI: it only talks to Ilven-AI, which acts through the user's connex.
 */
type Msg = { role: "user" | "assistant"; content: string };
type Action = { tool: string; ok: boolean; result?: unknown; error?: string };

const ICON = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9zM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7z"/></svg>`;

const CSS = `
:host { all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; font: 14px/1.45 system-ui, sans-serif; color: #1d1b26; }
button { font: inherit; cursor: pointer; }
.fab { width: 56px; height: 56px; border-radius: 50%; border: 0; color: #fff; background: linear-gradient(135deg, #6d4aff, #c03fff); box-shadow: 0 6px 20px rgba(80,40,200,.35); display: grid; place-items: center; }
.fab:focus-visible { outline: 3px solid #b9a8ff; outline-offset: 2px; }
.panel { position: absolute; right: 0; bottom: 70px; width: min(380px, calc(100vw - 40px)); height: min(540px, calc(100vh - 120px)); background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(20,10,60,.25); display: none; flex-direction: column; overflow: hidden; }
.panel.open { display: flex; }
header { padding: 12px 14px; background: #f5f2ff; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #e7e1ff; }
header strong { flex: 1; } header small { color: #6b6585; }
header button { border: 0; background: none; font-size: 18px; color: #6b6585; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.m { max-width: 85%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-wrap: break-word; }
.m.user { align-self: flex-end; background: #6d4aff; color: #fff; border-bottom-right-radius: 4px; }
.m.assistant { align-self: flex-start; background: #f1eff7; border-bottom-left-radius: 4px; }
.m.note { align-self: center; background: none; color: #6b6585; font-size: 12px; text-align: center; }
.m a { color: inherit; }
.act { font-size: 12px; color: #4a7b4a; } .act.bad { color: #a33; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; }
textarea { flex: 1; resize: none; border: 1px solid #d8d3ea; border-radius: 10px; padding: 8px 10px; font: inherit; min-height: 22px; max-height: 120px; }
form button { border: 0; border-radius: 10px; padding: 0 14px; background: #6d4aff; color: #fff; }
form button:disabled { opacity: .5; cursor: default; }
`;

export class IlvenAssistant extends HTMLElement {
  tokenProvider?: () => Promise<string | null> | string | null;
  contextProvider?: () => unknown;
  private root: ShadowRoot;
  private messages: Msg[] = [];
  private confirmation?: string;
  private busy = false;
  private els!: { panel: HTMLElement; log: HTMLElement; input: HTMLTextAreaElement; send: HTMLButtonElement; sub: HTMLElement };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  get app() { return this.getAttribute("app") ?? ""; }
  get endpoint() { return this.getAttribute("endpoint") ?? "/ai/api"; }

  connectedCallback() {
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="panel" role="dialog" aria-label="Ilven assistant">
        <header><strong>Assistant</strong><small></small><button type="button" class="close" aria-label="Close">×</button></header>
        <div class="log" aria-live="polite"></div>
        <form><textarea rows="1" placeholder="Ask anything…" aria-label="Message"></textarea><button type="submit">Send</button></form>
      </div>
      <button class="fab" type="button" aria-label="Open Ilven assistant">${ICON}</button>`;
    const $ = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.els = { panel: $(".panel"), log: $(".log"), input: $("textarea"), send: $("form button"), sub: $("header small") };
    $<HTMLButtonElement>(".fab").onclick = () => this.toggle();
    $<HTMLButtonElement>(".close").onclick = () => this.toggle(false);
    $<HTMLFormElement>("form").onsubmit = (e) => { e.preventDefault(); void this.send(); };
    this.els.input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.send(); } };
  }

  private async headers(): Promise<HeadersInit> {
    const t = await this.tokenProvider?.();
    return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
  }

  private toggle(open = !this.els.panel.classList.contains("open")) {
    this.els.panel.classList.toggle("open", open);
    if (open) {
      this.els.input.focus();
      if (!this.els.log.childElementCount) void this.loadStatus();
    }
  }

  private async loadStatus() {
    try {
      const res = await fetch(`${this.endpoint}/status?app=${encodeURIComponent(this.app)}`, { headers: await this.headers(), credentials: "same-origin" });
      const s = await res.json();
      if (s.status === "ok") {
        this.els.sub.textContent = s.preset?.name ? `scope: ${s.preset.name}` : "";
        this.note(s.preset?.allowedTools ? "Ask me to do things in this app." : "No actions are enabled for you in this app yet.");
      } else if (s.status === "not_registered") {
        this.note(s.message, { href: `/account/?return=${encodeURIComponent(location.href)}`, label: "Register with Ilven" });
      } else this.note(s.message ?? "The assistant is unavailable.");
    } catch {
      this.note("The assistant is unavailable.");
    }
  }

  private add(role: string, text: string) {
    const d = document.createElement("div");
    d.className = `m ${role}`;
    d.textContent = text;
    this.els.log.append(d);
    this.els.log.scrollTop = this.els.log.scrollHeight;
    return d;
  }

  private note(text: string, link?: { href: string; label: string }) {
    const d = this.add("note", text);
    if (link) {
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = ` ${link.label}`;
      d.append(a);
    }
  }

  private pageContext(): unknown {
    const declared = [...document.querySelectorAll<HTMLElement>("[data-ilven-context]")].flatMap((el) => {
      try { return [JSON.parse(el.dataset.ilvenContext!)]; } catch { return []; }
    });
    let provided: unknown;
    try { provided = this.contextProvider?.(); } catch { provided = undefined; }
    return { url: location.pathname + location.hash, title: document.title, ...(declared.length ? { declared } : {}), ...(provided !== undefined ? { app: provided } : {}) };
  }

  private async send() {
    const text = this.els.input.value.trim();
    if (!text || this.busy) return;
    this.els.input.value = "";
    this.messages.push({ role: "user", content: text });
    this.add("user", text);
    this.busy = true;
    this.els.send.disabled = true;
    const typing = this.add("note", "…");
    try {
      const res = await fetch(`${this.endpoint}/chat`, {
        method: "POST",
        headers: await this.headers(),
        credentials: "same-origin",
        body: JSON.stringify({ app: this.app, messages: this.messages.slice(-30), pageContext: this.pageContext(), confirmation: this.confirmation }),
      });
      const r = await res.json();
      typing.remove();
      if (!res.ok) throw new Error(r.message ?? `HTTP ${res.status}`);
      this.confirmation = r.pendingConfirmation?.token;
      for (const a of (r.actions ?? []) as Action[]) {
        const d = this.add("note", `${a.ok ? "✓" : "✗"} ${a.tool}`);
        d.classList.add("act");
        if (!a.ok) d.classList.add("bad");
      }
      if (r.reply) {
        this.messages.push({ role: "assistant", content: r.reply });
        this.add("assistant", r.reply);
      }
      if (r.actions?.length) this.dispatchEvent(new CustomEvent("ilven:actions", { detail: r.actions, bubbles: true, composed: true }));
    } catch (e) {
      typing.remove();
      this.messages.pop();
      this.note(`Something went wrong: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.els.send.disabled = false;
    }
  }
}

if (!customElements.get("ilven-assistant")) customElements.define("ilven-assistant", IlvenAssistant);
