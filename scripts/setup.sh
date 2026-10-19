#!/usr/bin/env bash
# AlgoDesk India — Linux / macOS setup:  bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=================================================="
echo "   AlgoDesk India — setup"
echo "=================================================="

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js not found. Install Node.js 22 LTS: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[X] Node.js v$NODE_MAJOR found — need 20.9+ (22 LTS recommended)"
  exit 1
fi
echo "[OK] Node $(node -v)"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] Created .env (edit DATABASE_URL if needed)"
fi
node scripts/admin-cli.mjs init-env

if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "[OK] PostgreSQL is accepting connections"
  else
    echo "[!] PostgreSQL not reachable on 127.0.0.1:5432 — start it: sudo systemctl start postgresql"
  fi
fi

echo "[1/3] Installing packages…"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
echo "[2/3] Building…"
npm run build
echo "[3/3] Starting on http://localhost:${PORT:-3000}  (Ctrl+C to stop)"
exec npm start
