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
# The agent binaries and the ComfyUI storage helper are *served*, not executed
# here: rippel hands them to a remote machine on request. Shipping them beside
# dist/ is what makes an install always match the rippel driving it.
#
# The binaries are built outside this image, by `npm run build:release -w
# @comfy/agent`, because building them needs a Go toolchain and this is a Node
# image — adding one would multiply the build's size for four files that cross
# compile from anywhere in seconds. Build them first, then build this image.
# If apps/agent/dist is empty the image is still valid: the Deployment screen
# says the downloads are missing rather than offering links that 404.
COPY apps/agent/dist apps/api/dist/agent-bin
COPY tools/comfyui-rippel-storage apps/api/dist/helper-source

# Run unprivileged. The node image already provides uid/gid 1000.
RUN mkdir -p /data/assets && chown -R node:node /data
USER node

EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
