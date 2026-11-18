# DeltaX Blackout — Minimal Judge Deployment Container
#
# Constraints & Guarantees per docs/RELEASE-CONFIG-014.md:
# - Base image: official node:22.23.2-bookworm-slim.
# - Clean dependency install from pinned lockfile with npm ci --ignore-scripts.
# - Compiles TypeScript application inside build stage.
# - Runtime executes strictly as non-root 'node' user.
# - Application binds 127.0.0.1:3000 by default (never starts a public listener).
# - Fronted by reverse proxy (e.g. Caddy) via Linux host network (--network host)
#   (the application remains loopback-only).
# - Private ledger / credentials must be operator-supplied at runtime via volumes/env;
#   never baked into the container image.
# - Includes source web assets (src/web) and evidence fixtures (docs/evidence/mcp-lab.json).

# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22.23.2-bookworm-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies without running arbitrary lifecycle scripts
RUN npm ci --ignore-scripts

# Copy source files, build config, and static assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY docs/evidence/ ./docs/evidence/

# Compile TypeScript application to dist/
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22.23.2-bookworm-slim

WORKDIR /app

# Set production environment defaults
ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=3000

# Install production-only dependencies from pinned lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled application from builder
COPY --from=builder /app/dist ./dist

# Copy source web assets and offline evidence fixtures
COPY src/web ./src/web
COPY src/rig/web ./src/rig/web
COPY docs/evidence ./docs/evidence

# Ensure non-root node user owns application files
RUN chown -R node:node /app

# Switch to standard non-root user provided by the official Node image
USER node

# Note on networking:
# The server binds 127.0.0.1:3000 by default. On Linux, run container with
# `--network host` behind a local Caddy reverse proxy, or configure Caddy within
# a service on the same host network.
# Do not expose ports directly to public interfaces.

CMD ["node", "dist/src/server.js"]
