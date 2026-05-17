# syntax=docker/dockerfile:1.7
#
# Sankhya Ajuda MCP Server — Fase 2 (Node.js 22 LTS + TypeScript)
# Skills IT — Soluções em Tecnologia
# https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
#
# Multi-stage build:
#   1. builder  — installs full deps + compiles TS -> dist/
#   2. deps     — installs only production dependencies
#   3. final    — alpine + production deps + dist/. ~150 MB image.

# ─── Builder ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Cache deps (only re-runs if package*.json changes)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build TypeScript -> dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production deps ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Final ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS final

LABEL org.opencontainers.image.title="sankhya-ajuda-mcp" \
      org.opencontainers.image.description="MCP server for Sankhya Help Center — hybrid RRF search over 6,123 articles" \
      org.opencontainers.image.vendor="Skills IT — Soluções em Tecnologia" \
      org.opencontainers.image.authors="Skills IT <contato@skillsit.com.br>" \
      org.opencontainers.image.url="https://www.skillsit.com.br" \
      org.opencontainers.image.source="https://github.com/skillsit/sankhya-ajuda-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.2.0"

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3105

# curl needed for HEALTHCHECK
RUN apk add --no-cache curl \
    && addgroup -S sankhya -g 1000 \
    && adduser -S sankhya -G sankhya -u 1000

WORKDIR /app

# Copy production deps + compiled output
COPY --from=deps     /deps/node_modules ./node_modules
COPY --from=builder  /build/dist        ./dist
COPY                 package.json       ./

USER sankhya

EXPOSE 3105

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3105/health || exit 1

CMD ["node", "dist/index.js"]
