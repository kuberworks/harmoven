FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
# --legacy-peer-deps: better-auth@1.5.x pulls @better-auth/core@1.5.6 which declares
# peer better-call@1.3.2 and jose@^6, but the project intentionally ships
# better-call@2.0.3 (direct dep) and jose@5.x — both verified working at runtime.
# This flag is scoped to this Docker build stage only and does not affect lockfile
# integrity (npm ci still verifies checksums against package-lock.json).
RUN npm ci --omit=dev --legacy-peer-deps

FROM base AS builder
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps
# Copy Prisma schema before generating types — the client codegen requires
# the schema to be present and must run before `next build` type-checks the app.
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
# Better Auth validates AUTH_SECRET at module initialisation time, which causes
# Next.js static-analysis (page data collection) to crash during `npm run build`
# if the variable is absent.  We supply a build-time placeholder here — it is
# never used at runtime because the real value is injected via env_file / shell.
ARG AUTH_SECRET=build-time-placeholder-not-used-at-runtime
ENV AUTH_SECRET=$AUTH_SECRET
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public/ is optional — only copy if it exists (no static assets currently in repo)
RUN mkdir -p ./public
COPY orchestrator.yaml ./
# Prisma schema + migrations — needed by prisma migrate deploy at startup
COPY --from=builder /app/prisma ./prisma
# prisma.config.ts — Prisma 7 reads this file to resolve datasource.url at runtime
COPY --from=builder /app/prisma.config.ts ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
# Create /data for config-git storage (lib/config-git/paths.ts default).
# Must run as root (before USER switch) so the dir is owned by nextjs.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs
EXPOSE 3000
ENV PORT=3000
# HOSTNAME=0.0.0.0 forces Next.js standalone to bind on all interfaces.
# Without this, Docker sets HOSTNAME to the container name which resolves to
# the container's internal IP only — breaking port forwarding and health checks.
ENV HOSTNAME=0.0.0.0
CMD ["./entrypoint.sh"]
