#!/bin/sh
set -eu

API_PORT=${MURPH_API_PORT:-${PORT:-10000}}

export PORT=$API_PORT
export MURPH_JVM_PORT=${MURPH_JVM_PORT:-8787}
export MURPH_JVM_WORKER_URL=${MURPH_JVM_WORKER_URL:-http://127.0.0.1:${MURPH_JVM_PORT}}
export MURPH_JVM_CACHE_DIR=${MURPH_JVM_CACHE_DIR:-/data/jvm}

echo "Starting API server on port $PORT..."
echo "JVM worker will be managed by jvm-manager.ts on port $MURPH_JVM_PORT"

exec node --enable-source-maps artifacts/api-server/dist/index.mjs

