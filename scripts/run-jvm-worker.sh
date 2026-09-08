#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SOURCE_DIR=${MURPH_JVM_SOURCE_DIR:-"$ROOT_DIR/.cache/cncverse-bridge"}
SOURCE_REPO=${MURPH_JVM_SOURCE_REPO:-"https://github.com/deepu2135/CNCVerse-Bridge.git"}
SOURCE_REF=${MURPH_JVM_SOURCE_REF:-main}

if [ ! -x "$SOURCE_DIR/gradlew" ]; then
  mkdir -p "$(dirname "$SOURCE_DIR")"
  rm -rf "$SOURCE_DIR"
  git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" "$SOURCE_DIR"
fi

rm -rf "$SOURCE_DIR/headlessApp"
cp -R "$ROOT_DIR/scripts/jvm-worker" "$SOURCE_DIR/headlessApp"

if ! grep -q 'include(":headlessApp")' "$SOURCE_DIR/settings.gradle.kts"; then
  printf '\ninclude(":headlessApp")\n' >> "$SOURCE_DIR/settings.gradle.kts"
fi

export MURPH_JVM_CACHE_DIR=${MURPH_JVM_CACHE_DIR:-"$ROOT_DIR/data/jvm"}
export PORT=${PORT:-8787}

cd "$SOURCE_DIR"
./gradlew :headlessApp:installDist --no-daemon
exec "$SOURCE_DIR/headlessApp/build/install/headlessApp/bin/headlessApp"