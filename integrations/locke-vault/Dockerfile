# syntax=docker/dockerfile:1
# Locke-Vault image. Build context: repository root (the vault uses the shared @ilven/* client libraries in packages/).
FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN npm run build -w @ilven-integrations/locke-vault

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build /src/integrations/locke-vault/dist/ ./
# Image previews (thumbnails, display sizes): sharp and its native libvips, outside the bundle.
COPY --from=build /src/node_modules/sharp ./node_modules/sharp
COPY --from=build /src/node_modules/@img ./node_modules/@img
COPY --from=build /src/node_modules/semver ./node_modules/semver
COPY --from=build /src/node_modules/detect-libc ./node_modules/detect-libc
CMD ["node", "--enable-source-maps", "index.mjs"]
