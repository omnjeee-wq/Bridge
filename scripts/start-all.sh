#!/bin/sh
set -eu

API_PORT=${MURPH_API_PORT:-${PORT:-10000}}

if [ "${MURPH_JVM_ENABLED:-false}" = "true" ]; then
  export MURPH_JVM_WORKER_URL=${MURPH_JVM_WORKER_URL:-http://127.0.0.1:8787}
  export MURPH_JVM_CACHE_DIR=${MURPH_JVM_CACHE_DIR:-/data/jvm}
  export PORT=8787

  echo "Starting JVM worker..."
  /app/jvm-worker/bin/headlessApp > /tmp/murph-jvm-worker.log 2>&1 &
  JVM_PID=$!

  sleep 3

  if kill -0 "$JVM_PID" 2>/dev/null; then
    echo "JVM worker process is running (PID: $JVM_PID)"
  else
    echo "ERROR: JVM worker exited during startup"
  fi

  if [ -f /tmp/murph-jvm-worker.log ]; then
    echo "----- JVM worker startup log -----"
    cat /tmp/murph-jvm-worker.log
    echo "----- End JVM worker log -----"
  fi

  trap 'kill "$JVM_PID" 2>/dev/null || true' INT TERM EXIT
else
  echo "JVM worker disabled: MURPH_JVM_ENABLED is not true"
fi

export PORT=$API_PORT
echo "Starting API server on port $PORT..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
