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
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY orchestrator.yaml ./
# Prisma schema + migrations — needed by prisma migrate deploy at startup
COPY --from=builder /app/prisma ./prisma
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["./entrypoint.sh"]
