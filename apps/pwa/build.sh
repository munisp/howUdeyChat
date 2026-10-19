#!/bin/sh
# apps/pwa/build.sh — vendor the shared core into the PWA so the service
# worker (scoped to apps/pwa/) can precache it. Run after editing
# packages/matrix-lite.
set -eu
cd "$(dirname "$0")"
rm -rf vendor/matrix-lite
mkdir -p vendor
cp -r ../../packages/matrix-lite vendor/matrix-lite
echo "vendored packages/matrix-lite -> apps/pwa/vendor/matrix-lite"
