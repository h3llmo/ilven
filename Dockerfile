# syntax=docker/dockerfile:1
# Platform images. One shared build stage (typecheck + unit tests + build), one small runtime target per service.

FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN npm run typecheck && npm test && npm run build

FROM node:22-alpine AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
CMD ["node", "--enable-source-maps", "index.mjs"]

FROM node-runtime AS nevli
COPY --from=build /src/platform/nevli/dist/ ./

FROM node-runtime AS ilven-ai
COPY --from=build /src/platform/ilven-ai/dist/ ./

FROM node-runtime AS nevli-dms
COPY --from=build /src/platform/nevli-dms/dist/ ./

FROM caddy:2.10-alpine AS gateway
COPY platform/gateway/Caddyfile /etc/caddy/Caddyfile
COPY platform/gateway/site/ /srv/
COPY --from=build /src/platform/nevli-web/dist/ /srv/admin/
COPY --from=build /src/platform/ilven-account/dist/ /srv/account/
COPY --from=build /src/platform/ui-plugin/dist/ /srv/plugin/

# Object storage (Garage, S3-compatible). Config only; secrets come from the generated-secrets volume.
FROM dxflrs/garage:v2.1.0 AS garage
COPY platform/storage/garage.toml /etc/garage.toml
