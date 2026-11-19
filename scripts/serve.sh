#!/usr/bin/env bash
# Webhooks + booking page + dashboard. Follow-ups run every 5 minutes in-process (or use cron: npm run tick).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
TICK_EVERY_MS="${TICK_EVERY_MS:-300000}" exec npx tsx src/cli.ts serve
