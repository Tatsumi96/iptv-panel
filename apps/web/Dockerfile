# syntax=docker/dockerfile:1

# ---------- Base ----------
FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace @iptv/web --include-workspace-root --no-audit --no-fund

# ---------- Build ----------
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# The panel calls the API on the same origin (nginx proxies /api/).
# NEXT_PUBLIC_API_URL stays empty by default so that the image works with
# any server IP address. Set it to target another API host.
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY apps/web ./apps/web
RUN npm run build --workspace @iptv/web

# ---------- Runtime ----------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.js ./apps/web/next.config.js
COPY --from=build /app/apps/web/package.json ./apps/web/package.json

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@iptv/web"]
