# ---------------------------------------------------------------------------
# Panzer Duel — game client + multiplayer battle room in one container.
#
#   docker build -t panzer-duel .
#   docker run -p 8080:8080 panzer-duel        # → http://localhost:8080
#
# Multi-stage: the build stage compiles the Vite client and bundles the
# TypeScript server (three/cannon-es/ws included) into ONE plain-JS file
# with esbuild, so the runtime stage ships no node_modules at all.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server

# client → dist/ ; server → single self-contained ESM bundle.
# The banner provides a real `require` so bundled CJS deps (ws) can load
# node builtins under ESM.
RUN npm run build && \
    npx esbuild server/main.ts \
      --bundle --platform=node --format=esm \
      --outfile=server-build/main.mjs \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --external:bufferutil --external:utf-8-validate

# ---------------------------------------------------------------------------

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/server-build/main.mjs ./server/main.mjs

EXPOSE 8080
USER node
CMD ["node", "server/main.mjs"]
