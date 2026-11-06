# Ilven

Self-hosted platform that gives containerized apps a scoped AI assistant. See [CLAUDE.md](CLAUDE.md) for the full design.

## Run

```sh
docker compose up -d
```

Open http://localhost:8080. Dev users (Keycloak): `admin` / `admin` (platform admin) and `alice` / `alice`.
Every secret is generated inside the stack on first start, so there is nothing to configure.

1. **Pilot** (http://localhost:8080/apps/pilot/): sign in, store your OpenAI key, generate images. Works without the assistant.
2. **Ilven Account** (/account/): register, choose what to share (age, gender), get your Ilven API key.
3. **Nevli** (/admin/, as `admin`): add an AI provider key to enable Ilven-AI, then allow tools in Pilot's presets.
   Until you do, the assistant refuses everything.

## Test

```sh
docker compose --profile test run --rm e2e
# with a real model (and real image generation):
E2E_ANTHROPIC_API_KEY=... E2E_OPENAI_API_KEY=... docker compose --profile test run --rm e2e
```

## Options

- **Container management from Nevli** (optional; needs docker.sock, which is root-equivalent): append
  `:compose.docker.yaml` to `COMPOSE_FILE` in `.env`.
- **Production with Cloudflare Access:** in `.env`, set `COMPOSE_FILE=compose.yaml`, `ILVEN_AUTH_MODE=cloudflare`,
  `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ILVEN_ADMIN_EMAILS` and `ILVEN_PUBLIC_URL`.
