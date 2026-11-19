#!/usr/bin/env bash
# Offline end-to-end demo (mock Twilio, mock HubSpot/GoHighLevel, simulated clock). Output -> docs/demo-output.txt
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install
npx tsx scripts/demo.ts "$@" | tee docs/demo-output.txt
