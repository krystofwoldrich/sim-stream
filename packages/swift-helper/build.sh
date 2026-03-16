#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building sim-stream-helper (arm64)..."

swift build \
    -c release \
    --arch arm64 \
    --build-path .build

mkdir -p bin
cp .build/arm64-apple-macosx/release/sim-stream-helper bin/sim-stream-helper

# Re-sign after copy (required for framework linking)
codesign -s - -f bin/sim-stream-helper 2>/dev/null

echo "Built: bin/sim-stream-helper"
