# Ilven

Self-hosted platform that gives containerized apps a scoped AI assistant. See [CLAUDE.md](CLAUDE.md) for the full design.

## Run

```sh
docker compose up -d
```

Open http://localhost:8080. Every secret is generated inside the stack on first start, so there is nothing to configure.
Keycloak users `admin` (platform admin) and `alice` get generated passwords on first start (the realm's seeded dev
passwords are replaced automatically). Read them with
`docker run --rm -v ilven_secrets:/s:ro alpine cat /s/keycloak-users/admin` and change them in the Keycloak account console.
Anyone can sign up (self-registration is on); brute-force protection is enabled.

### Public hosts

Exposed through the `home-warlock` Cloudflare tunnel (no Access policy; Keycloak handles login):
https://ilven-auth.home-warlock.com (identity provider), https://ilven-account.home-warlock.com,
https://ilven-admin.home-warlock.com, https://ilven-pilot.home-warlock.com. The root of `ilven-<app>.<domain>` opens
`/apps/<app>/`. To add an app host, add its name to `ILVEN_PUBLIC_HOSTS` in `.env` (Keycloak redirect URIs are
updated on start) and add a tunnel route and DNS record for it. Integrated systems keep their own name
(`https://locke-vault.home-warlock.com`): list them in `ILVEN_APP_HOSTS`; `<app>.<domain>` opens `/apps/<app>/`. The Keycloak admin console and master realm are only
reachable from `localhost`.

1. **Pilot** (http://localhost:8080/apps/pilot/): sign in, store your OpenAI key, generate images. Works without the assistant.
2. **Ilven Account** (/account/): register, choose what to share (age, gender), get your Ilven API key.
3. **Nevli** (/admin/, as `admin`): add an AI provider key to enable Ilven-AI, then allow tools in Pilot's presets.
   Until you do, the assistant refuses everything.
4. **Locke Vault** (/apps/locke-vault/): your encrypted staging area (256 MB). Upload files or stage them from a data
   source (your Ilven documents, Pilot images), browse versions, save the version you want to your documents.

## Test

```sh
docker compose --profile test run --rm e2e
# with a real model (and real image generation):
E2E_ANTHROPIC_API_KEY=... E2E_OPENAI_API_KEY=... docker compose --profile test run --rm e2e
```

## Options

- **Container management from Nevli** (optional; needs docker.sock, which is root-equivalent): append
  `:compose.docker.yaml` to `COMPOSE_FILE` in `.env`. Nevli reaches Docker only through `wollomatic/socket-proxy`, whose
  allowlist permits exactly `GET /containers/json` and `POST /containers/<id>/restart`, and only from the nevli container.
- **Production with Cloudflare Access:** in `.env`, set `COMPOSE_FILE=compose.yaml`, `ILVEN_AUTH_MODE=cloudflare`,
  `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ILVEN_ADMIN_EMAILS` and `ILVEN_PUBLIC_URL`.
