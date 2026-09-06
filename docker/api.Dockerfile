# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install against the workspace manifests first so this layer caches across
# source edits.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @comfy/shared && npm run build -w @comfy/api

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# Migrations are read from disk at boot, so they ship as files rather than
# being compiled in.
COPY apps/api/src/migrations apps/api/dist/migrations
# The agent's source and the ComfyUI storage helper are *served*, not executed
# here: rippel hands them to a remote machine on request. Shipping them beside
# dist/ is what makes an agent install always match the rippel driving it.
COPY apps/agent/src apps/api/dist/agent-source
COPY tools/comfyui-rippel-storage apps/api/dist/helper-source

# Run unprivileged. The node image already provides uid/gid 1000.
RUN mkdir -p /data/assets && chown -R node:node /data
USER node

EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
