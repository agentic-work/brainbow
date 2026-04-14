# Copyright (c) 2024-2026 AgenticWork LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying prohibited.

# =============================================================================
# GhostPilot — shared browser control + recording studio
# =============================================================================
# Bundles puppeteer-core + system Chromium + ffmpeg.
# Multi-arch (linux/amd64, linux/arm64).
# =============================================================================

FROM node:20-slim AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        ffmpeg \
        dumb-init \
    && rm -rf /var/lib/apt/lists/*

# node:20-slim already ships a non-root `node` user (uid 1000) — reuse it
WORKDIR /app
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ui.html ./

USER node

ENV NODE_ENV=production \
    GHOST_PORT=4444 \
    CHROME_PATH=/usr/bin/chromium \
    GHOST_RECORDINGS=/tmp/ghostpilot-recordings

EXPOSE 4444

LABEL org.opencontainers.image.title="ghostpilot"
LABEL org.opencontainers.image.description="Shared browser control + recording studio — human and AI copiloting a real browser"
LABEL org.opencontainers.image.source="https://github.com/agentic-work/ghostpilot"
LABEL org.opencontainers.image.licenses="LicenseRef-Proprietary"
LABEL org.opencontainers.image.vendor="AgenticWork LLC"

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.GHOST_PORT||4444)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
