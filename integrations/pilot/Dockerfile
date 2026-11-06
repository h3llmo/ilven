# syntax=docker/dockerfile:1
# Pilot image. Build context: repository root (Pilot uses the shared @ilven/* client libraries in packages/).
FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN npm run build -w @ilven-integrations/pilot

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build /src/integrations/pilot/dist/ ./
CMD ["node", "--enable-source-maps", "index.mjs"]
