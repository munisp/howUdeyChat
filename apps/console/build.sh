#!/bin/sh
# apps/console/build.sh — vendor the shared core into the staff console.
set -eu
cd "$(dirname "$0")"
rm -rf vendor/matrix-lite
mkdir -p vendor
cp -r ../../packages/matrix-lite vendor/matrix-lite
echo "vendored packages/matrix-lite -> apps/console/vendor/matrix-lite"
