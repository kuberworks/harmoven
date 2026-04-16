#!/bin/sh
# entrypoint.sh — Harmoven container startup
# Runs pending Prisma migrations (idempotent) then seeds built-in data,
# then starts the Next.js server.
# Using sh (not bash) for Alpine compatibility.
set -e

echo "[entrypoint] Applying pending database migrations..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Seeding built-in data (idempotent)..."
node prisma/seed-runner.mjs

echo "[entrypoint] Starting Harmoven..."
exec node server.js
