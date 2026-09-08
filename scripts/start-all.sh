#!/bin/sh
set -eu

API_PORT=${MURPH_API_PORT:-${PORT:-10000}}

if [ "${MURPH_JVM_ENABLED:-false}" = "true" ]; then
  export MURPH_JVM_WORKER_URL=${MURPH_JVM_WORKER_URL:-http://127.0.0.1:8787}
  export MURPH_JVM_CACHE_DIR=${MURPH_JVM_CACHE_DIR:-/data/jvm}
  export PORT=8787
  /app/jvm-worker/bin/headlessApp > /tmp/murph-jvm-worker.log 2>&1 &
  JVM_PID=$!
  trap 'kill "$JVM_PID" 2>/dev/null || true' INT TERM EXIT
fi

export PORT=$API_PORT
exec node --enable-source-maps artifacts/api-server/dist/index.mjs