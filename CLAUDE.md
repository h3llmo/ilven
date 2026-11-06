# Ilven — Project Context

> Context for AI coding agents working on this repository.
> **[TBC]** = assumption to confirm. **[OPEN]** = not decided yet; ask before implementing.

## 1. Summary

Ilven is a self-hosted, Docker Compose–based platform that lets any containerized app be
driven by a **scoped AI assistant (Ilven-AI)**. Each user gets one **Ilven-Connex** per app,
whose scope (allowed actions and rules) comes from a **preset** managed in Nevli and selected
from the user's profile. An embeddable widget (**Ilven-UI-Plugin**) gives end users a prompt
instead of forms.

**The platform is app-agnostic and reusable.** It generalizes the AI-assistant layer previously
rebuilt inside each individual app.

**Ilven's perimeter is AI assistance only.** An app's business (its features, data, and the
third-party services it uses, such as OpenAI) stays inside the app. An app integrates Ilven
when it wants to offer an AI assistant to its users; that integration is where the platform enters.

**Locke** (an AI photo editor) is the first app integrated with the platform and the MVP.
Locke is an *integration*: the platform must never depend on Locke. Removing Locke leaves a
fully working, generic platform.

**BYOK:** the AI provider keys that power Ilven-AI are supplied by the operator. None are bundled.

## 2. Core principles (invariants — never violate)

1. **Self-contained.** Everything runs in Docker Compose. Persistent state lives only in
   Docker-managed volumes and Postgres.
2. **Zero host permissions required.** `docker compose up` must work with only the right to
   start Docker: no bind mounts to host directories, no `docker.sock` required.
   `docker.sock` and host volume directories are **optional** extras granted by the host
   administrator. Without `docker.sock`, everything works except container orchestration by Nevli.
3. **No manual steps.** Users never run commands. No scripts on the host: migrations,
   seeding and initialization run inside containers (entrypoints / init containers).
4. **AI is optional.** Every app MUST remain fully usable through its own UI and API when
   Ilven-AI is disabled or no AI provider key is configured.
5. **Ilven stays out of app business.** The platform never stores or uses an app's third-party
   credentials and never calls an app's third-party services. Apps handle those themselves.
6. **Only Ilven-AI uses connexes.** Apps, their front-ends/back-ends and their outbound calls
   communicate the conventional way (REST clients, client APIs). That code is predictable and
   needs no restriction. Connexes exist solely to constrain Ilven-AI.
7. **Ilven-AI acts only through a connex, only within its preset.** Ilven-AI never calls an app
   directly. Out-of-scope requests are refused with an explanation.
   Example: if "remove retention labels" is not an allowed action in the user's DMS preset,
   Ilven-AI refuses, even if the DMS supports it.
8. **Safe by default.** A new connex starts with an empty preset: Ilven-AI can do nothing until
   tools are explicitly allowed.
9. **Security first**, even though there is no business model yet.

## 3. Glossary

| Term | Definition |
|---|---|
| **App** | Any container in the compose stack that is not part of Ilven itself (Postgres, Nginx, MinIO, Locke…). Provides the actual value. |
| **Ilven-App** | An app integrated with Ilven: uses the shared SSO, exposes an MCP server for Ilven-AI, optionally embeds the UI-Plugin. |
| **Landing zone** | One Ilven deployment (one compose stack / one domain). A user can use every Ilven-App in their landing zone. [TBC] |
| **Nevli** | Control plane. Own Postgres. Manages users, profiles, plans, API keys, presets, connexes, operator AI keys, and containers (via optional `docker.sock`). |
| **Nevli-Web** | Admin UI for Nevli, using a privileged admin access. Embeds an assistant that operates Nevli through a connex to Nevli's MCP. |
| **Nevli-DMS** | Very light document management service in its own container. API for the essential operations on binaries (upload, download, list, delete, basic metadata), with per-user permissions enforced at the API level, not the filesystem. Data on a Docker volume. MinIO is an optional heavier alternative. |
| **Ilven-Account** | Login and account settings. Dev: Keycloak. Prod: Cloudflare Access. Users are keyed by the IdP `sub` claim. Holds the user's opt-in choices for sharing **age** and **gender** with Ilven. |
| **Ilven-User** | Ilven's user record in Nevli, linked to an IdP `sub`, with a **user profile**. |
| **User profile** | What Nevli knows about a user for preset selection: **age** and **gender**, each only if the user opted in to share it, plus Ilven data such as their plan. Nothing else. |
| **Ilven-Plan** | The user's plan. MVP: a single free plan whose only effect is issuing the user's **Ilven API key**. |
| **Ilven API key** | Per-user key issued by Nevli. The only Ilven credential: used by connexes to call Ilven-Apps on the user's behalf. Identity tokens are never used as API keys. |
| **Preset** | A named scope for one Ilven-App: a subset of the app's MCP tools (allowed actions) plus rules for Ilven-AI. Managed in Nevli. Each app has a **default preset** and may have others. |
| **Default preset** | The preset used when the user shares no profile data or no assignment criterion matches. Created empty for every app. |
| **Preset assignment** | Ordered criteria on profile attributes (age, gender) mapping users to presets. The first matching criterion by priority wins; no match → default preset. |
| **Ilven-Connex** | Binding of one user × one Ilven-App. Carries the user's Ilven API key and the preset resolved for that user. |
| **Ilven-AI** | The orchestrating agent (LLM + tool loop). Acts for the system by default, and for users only through their connexes. |
| **Ilven-UI-Plugin** | Embeddable widget: a "magic" button (Ilven logo [TBC]) that opens a prompt panel. Sends the prompt **plus page context** to Ilven-AI. |
| **Pilot** | Spike app: generate images from a prompt via OpenAI, store them in Nevli-DMS. |
| **Locke** | First app integrated with the platform; MVP for end users. |

## 4. Components

### 4.1 Nevli (control plane)
- REST API (OpenAPI) and MCP server exposing admin actions (users, profiles, plans, API keys,
  presets, connexes, containers). **During development, Nevli's REST API and MCP tools must be kept in sync.**
- **Preset management:**
  - discovers each Ilven-App's available tools by listing them from the app's MCP server;
  - creates an **empty default preset** for every registered Ilven-App;
  - stores presets (allowed tools + rules) and the prioritized assignment criteria;
  - resolves the preset of each connex from the user's profile (first match by priority, else default).
- **Target design (after spike):** apps provide their own presets by calling a Nevli API at registration.
- Holds operator AI provider keys (Anthropic, OpenAI, Gemini…). If at least one is configured,
  Ilven-AI is enabled across the landing zone.
- If `docker.sock` is granted, talks to Docker through a socket proxy restricted to the
  containers of the Ilven compose project.

### 4.2 Ilven-Connex (per user × Ilven-App)
- **Target:** the Ilven-App's MCP server.
- **Credential:** the user's Ilven API key (automatic).
- **Scope:** the preset resolved for this user and app (allowed tools + rules).
- Created automatically when the user gets their API key, or when a new Ilven-App is registered.
- Re-resolved when the user's shared profile data, the presets, or the assignment criteria change.

### 4.3 Ilven-AI (core)
- Builds every session from the user's connex: the model only receives the preset's allowed tools and rules.
- **Scope is enforced in the Ilven-AI core code**, not just in the model's instructions:
  tools outside the preset are never given to the model, and every tool call is validated
  against the preset before execution.
- Acts knowing the credential belongs to the user: actions are performed *as that user* and can
  have real consequences for them (their data, and any costs the app incurs on their behalf).
- **No interface friction, but confirmation:** Ilven-AI applies sensible defaults instead of making
  the user fill in options. For destructive or irreversible actions (delete, overwrite, restart,
  retention changes) it asks for confirmation in the conversation itself, without forms or dialogs.

### 4.4 Ilven-UI-Plugin
- Default UI: a magic icon button that opens a prompt assistant.
- Not a plain relay: it captures **page context** (current view, selected item IDs, visible state)
  according to an integration config written by a developer or produced by an agentic analysis of the app.
- The plugin never calls the app's backend itself on behalf of the AI. Its requests go to Ilven-AI,
  which acts through the connex.
- Apps MUST work without the plugin. Embedding an assistant in an app without the plugin is discouraged.

### 4.5 Ilven-Account
- Handles login (Keycloak in dev, Cloudflare Access in prod) and account settings.
- Offers two independent opt-in options: **share my age with Ilven** and **share my gender with Ilven**.
  Both off by default [TBC].
- Only shared attributes flow to Nevli. Turning an option off removes the attribute from Nevli
  and the user falls back to presets that don't depend on it (default preset if nothing matches).

### 4.6 Infrastructure apps
- **Postgres:** all persistence. Each service may have its own Postgres instance.
- **Keycloak (dev):** minimal OIDC/OAuth2. Social login optional.
- **Cloudflare Access (prod):** protects access to Locke and other public apps.

## 5. Key flows

### 5.1 Login and registration
1. User opens an Ilven-App and is redirected to the IdP.
2. The app reads `sub` from the login.
3. If no Ilven-User exists for this `sub`, the app starts the registration flow on Ilven-Account
   (create the user, choose whether to share age and/or gender, choose a plan).
4. Shared attributes (if any) flow to Nevli.
5. On plan selection, Nevli issues the user's Ilven API key, resolves presets from the profile,
   and creates connexes for all Ilven-Apps.

### 5.2 Preset resolution
For each connex: evaluate the app's assignment criteria in priority order against the user's
shared attributes. First match wins. No match, or nothing shared → default preset.

### 5.3 Conventional (non-AI) calls
Front-ends, back-ends and services call each other directly with their usual clients and credentials,
including calls to third-party services (e.g. Pilot → OpenAI with the key the user stored in Pilot).
No connex involved.

### 5.4 AI action through the plugin
1. User types a request in the plugin. The plugin attaches page context and sends it to Ilven-AI.
2. Ilven-AI loads the user's connex for this app and gives the model only its preset's tools and rules.
3. Ilven-AI calls the tools on the app's MCP server through the connex, with the user's Ilven API key.
4. The app executes (using its own third-party services if needed) and results flow back to the plugin.
5. Out-of-scope request → refused with an explanation. Destructive action → confirmed in the chat first.

Example: "enhance this image and blur the background" → Ilven-AI picks sensible settings and proceeds immediately.

### 5.5 Admin through Nevli-Web
Example: "restart the Locke front-end" → Nevli-Web assistant → Ilven-AI → Nevli connex →
Nevli MCP `restart_service` → Docker (through the socket proxy).

## 6. Security and privacy

- **Login vs. API keys:** SSO login identifies the user (`sub`). The Ilven API key is the only
  credential used by connexes. Identity tokens are never used as API keys.
- **API keys** are issued by Nevli, scoped to the user, revocable, and stored hashed.
- **Operator AI keys** are encrypted at rest, never sent to the browser, never logged, and never
  placed in the LLM context.
- **App-owned secrets** (e.g. a user's OpenAI key in Pilot) are the app's responsibility and must
  also be encrypted at rest. Ilven never sees them.
- **Scope enforcement** happens in the Ilven-AI core (see 4.3). Apps still check that the API key's
  user is authorized for the requested resource (defense in depth).
- **Profile data:** only age and gender, each strictly opt-in, revocable at any time from Ilven-Account.
  Never sent to the LLM unless a preset rule requires it [TBC]. Store age as the minimum needed
  for criteria (e.g. an age bracket or a birth year) rather than a full birth date [TBC].
- **Prompt injection:** content from apps, files, images or web pages is data, not instructions.
  Ilven-AI takes rules only from the system and the preset.
- **`docker.sock`** (optional) is root-equivalent: access only through a socket proxy with an endpoint
  allowlist and compose-project label filtering.

## 7. Credentials overview

| Credential | Owner | Stored in | Used for |
|---|---|---|---|
| Operator AI key(s): Anthropic / OpenAI / Gemini | Operator | Nevli (encrypted) | Running Ilven-AI itself |
| Ilven API key | User (issued by Nevli) | Nevli (hashed) | Connexes to Ilven-Apps |
| App's third-party credentials (e.g. user's OpenAI key in Pilot) | User / app | The app (encrypted) | The app's own business. Outside Ilven. |

## 8. Environments

| | Dev | Prod / MVP |
|---|---|---|
| Login | Keycloak | Cloudflare Access |
| Storage | Nevli-DMS | Nevli-DMS (MinIO optional) |

`sub` values differ between IdPs, so user records do not carry over between environments. This is expected.

## 9. Roadmap

### Phase 0 — Spike (Pilot)
Goal: prove the full chain end to end.
- User logs in (Keycloak), registers, optionally shares age and/or gender, receives an Ilven API key.
- Nevli creates the Pilot connex with the empty default preset.
- **Presets are managed by hand in Nevli-Web**, per connex: the admin adds Pilot's tools and rules.
  (Apps providing presets through a Nevli API comes later.)
- User stores their own OpenAI API key in Pilot (Pilot's business, encrypted in Pilot's database).
- User asks the assistant to generate images. Ilven-AI calls Pilot's MCP through the connex,
  constrained by the preset. Pilot calls OpenAI with the user's key.
- Results are stored in Nevli-DMS. The user can browse previous results, including by asking the assistant.

**Done when:** a fresh `docker compose up` (no host permissions beyond starting Docker) gives, with no manual steps:
1. login → register → connex with empty default preset → Ilven-AI refuses everything;
2. admin allows tools in Nevli-Web → prompt → image in DMS works;
3. an action outside the preset is refused.

### Phase 1a — MVP admin
- Nevli-Web: manage users, profiles, plans, API keys, presets, prioritized assignment criteria,
  connexes and containers, both through the UI and through its assistant.
- Nevli API for apps to register their own presets.

### Phase 1b — MVP end user (Locke, light version)
- Sessions; chat mode (simple questions, "generate a picture").
- Editing workflow: crop, enhance, background blur, beautify, erase.
- Generation: style presets with preview, speed vs. quality, number of results.
  (Locke's *style* presets are a Locke feature, unrelated to Ilven connex presets.)
- Face-swap with user-provided characters. **Requirements:** consent from the person whose face is used;
  label outputs as AI-generated (EU AI Act transparency).
- Locke embeds the UI-Plugin, exposes an MCP server for Ilven-AI, and registers its presets with Nevli.
  Users access it through their Locke connex.

## 10. Tech stack
Decided 2026-11-06.
- **Backend (all services):** TypeScript on Node.js. REST with an OpenAPI spec.
- **MCP:** official `@modelcontextprotocol/sdk` (TypeScript).
- **LLM client:** multi-provider (Anthropic, OpenAI, Gemini) behind one interface, for BYOK. [TBC: library choice]
- **Front-end:** React + Vite for Nevli-Web and Ilven-Account.
- **UI-Plugin:** framework-free Web Component (custom element, Shadow DOM), embeddable with one script tag.
- **Persistence:** Postgres, **one instance per service**, each with its own Docker volume.
- **Test tooling:** `node:test` + `tsx` (unit), containerised e2e suite (compose profile `test`).

## 11. Repository layout
Monorepo. Platform and integrations are strictly separated.
```
.env                  # compose defaults (no secrets). COMPOSE_FILE selects dev/prod/optional overlays
compose.yaml          # platform only; `include:`s integrations
compose.dev.yaml      # dev overlay: Keycloak (+ realm import) and the e2e test service (profile "test")
compose.docker.yaml   # OPTIONAL overlay: docker socket proxy for Nevli container management
Dockerfile            # platform images: shared build stage (typecheck + unit tests + build), one target per service
platform/
  gateway/            # Caddy: single origin, routes, static front-ends, /ilven-config.json
  keycloak/           # dev IdP image + realm "ilven" (users admin/admin, alice/alice)
  nevli/              # control plane: public API :3000, internal API + MCP :3001
  ilven-ai/           # assistant core (Vercel AI SDK), /ai/api
  nevli-dms/          # document store, /dms/api
  nevli-web/          # admin UI (React), /admin/
  ilven-account/      # registration + account settings (React), /account/
  ui-plugin/          # <ilven-assistant> Web Component, /plugin/ilven-plugin.js
packages/
  common/             # server lib: config, secrets, auth (OIDC / Cloudflare / API keys), crypto, db, MCP mount
  web-auth/           # browser lib: OIDC login (oidc-client-ts), authenticated fetch
integrations/
  pilot/              # spike app, own compose.yaml + Dockerfile
tests/e2e/            # end-to-end suite against the running stack
```
- Platform code never imports from `integrations/`. Removing an integration = removing its folder and its `include:` line.
- Run: `docker compose up -d` → http://localhost:8080. Tests: `docker compose --profile test run --rm e2e`.
- Unit tests: `node:test` via `tsx` (run inside the image build). Nevli's admin REST routes and MCP tools are both
  generated from `platform/nevli/src/ops.ts`; change operations there only.
- Gateway convention: `/apps/<name>/*` → container alias `app-<name>:8080` (apps opt in by declaring the alias).
- Secrets are generated on first start by init containers into Docker volumes; each service mounts only its
  subdirectories (`volume.subpath`). Postgres: one instance per service, each on an `internal` network.

## 12. Current status
2026-11-06: Phase 0 implemented. A fresh `docker compose up` (no host permissions, no manual steps) passes the
e2e suite: gateway, auth rejection, criterion 1 (register → empty default preset → deterministic refusal),
provider keys never returned, MCP tool discovery, REST/MCP parity, DMS per-user isolation, Pilot usable without
AI, preset resolution from shared profile data. Unit tests cover scope enforcement with the real AI SDK loop
(out-of-preset calls never executed) and destructive-action confirmation.
- Criteria 2 and 3 verified manually with a real LLM and OpenAI (generate, list, confirmed delete in Pilot).
- Not yet verified in e2e: criteria 2 and 3 against a real LLM and OpenAI (e2e test exists, runs when
  `E2E_ANTHROPIC_API_KEY` / `E2E_OPENAI_API_KEY` are set); UIs not clicked through in a browser;
  Cloudflare Access mode untested.
- `compose.docker.yaml` verified 2026-11-06 (enabled in this deployment): `wollomatic/socket-proxy` with a path allowlist
  (list containers, restart a container by id; only nevli may connect); create/exec/images/inspect return 403.
  Nevli `list_services` / `restart_service` work through it. The proxy runs as uid 0 with all capabilities dropped,
  read-only, so it can open the root-owned socket whatever the host's docker gid.
- No rate limiting yet; conversations are stateless (the plugin sends the history each turn).

### Public exposure (2026-11-06)
Hosts `ilven-{auth,account,admin,pilot}.home-warlock.com` route through the existing `home-warlock` Cloudflare tunnel
to the gateway (`192.168.1.14:8080`), with no Cloudflare Access policy: Keycloak is the gate. Keycloak runs in `start`
mode with a fixed issuer host (`ILVEN_AUTH_URL`). The `keycloak-config` job enforces on every start: brute-force
protection, open self-registration, redirect URIs for `ILVEN_PUBLIC_HOSTS`, and replacement of the seeded dev
passwords. The gateway waits for that job before serving. The admin console and master realm are blocked on public hosts.

### Decisions taken during Phase 0 [TBC — confirm or change]
1. **Ilven API key storage (§6):** verified by keyed hash (HMAC-SHA256); an AES-256-GCM sealed copy is also kept
   so Ilven-AI can present the key to apps. It is unsealed only by Nevli's internal session endpoint, only for the
   caller's own connex, and only when the preset allows at least one tool.
2. **Profile:** age stored as birth year only; gender values `female | male | non_binary | other`.
3. **Admins:** IdP realm role `ilven-admin` (dev) / `ILVEN_ADMIN_EMAILS` (Cloudflare). Synced on each identity call.
4. **App registration:** integrations self-register at startup over the internal API with an app secret
   (trust on first use). New apps get an empty default preset, so registration grants Ilven-AI nothing.
5. **REST/MCP parity exception:** `set_ai_provider_key` is REST-only, so operator keys never enter LLM context.
6. **Confirmations:** destructive tools (MCP `destructiveHint`) return `confirmation_required` and a signed,
   single-use token bound to (user, app, tool, arguments). It is honoured only if the user's next message is an
   explicit "yes"-type reply.
7. **Nevli as an app:** Nevli registers itself (kind `platform`); only admins get a Nevli connex. Its default preset
   is empty too: allow tools in Nevli-Web before using the Nevli assistant.
8. API key verification by apps is cached for 30 s (revocation can lag by up to 30 s).
9. Default AI models: Anthropic `claude-opus-5-5`, OpenAI `gpt-5`, Google `gemini-2.5-pro` (editable in Nevli-Web).
10. **Conversation scope (per preset):** `actions` (default: only requests the preset's tools can fulfil), `app`
    (also questions about the app, guided by the preset's `topics` text) or `open` (general assistant). For
    `actions`/`app`, a cheap guard model (per provider, default `claude-haiku-5-5` / `gpt-5-mini` /
    `gemini-2.5-flash`) classifies the conversation before the main model runs; anything but `ALLOW` is refused
    with a fixed message (fail closed). The system prompt repeats the scope as a second layer. Verified on the
    real model (off-topic "digits of PI" refused in Pilot, 2026-11-06).

## 13. Rules for agents working on this repo
- Never add host-side scripts, bind mounts, or anything requiring host permissions beyond starting Docker.
- Never make the platform depend on Locke or Pilot. Integration code stays in the integration.
- Never put app business (third-party services, their credentials) into the platform.
- Every feature must work without Ilven-AI (UI/API path first, AI path second).
- Never route conventional app-to-app calls through a connex; connexes are for Ilven-AI only.
- When changing Nevli's REST API, update its MCP tools in the same change.
- Never give Ilven-AI a tool that is not in the user's preset. New presets start empty.
- Never collect profile data beyond age and gender, and never without the user's opt-in.
- Never log or return secrets.
- Ask before deciding anything marked [OPEN] or touching the security model (§6).