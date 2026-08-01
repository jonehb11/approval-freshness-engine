#!/usr/bin/env bash
# Bundles the Lambda handler + the runtime config into dist-lambda/function.zip.
# Everything the engine needs at runtime is inlined by esbuild EXCEPT difftastic, which ships as
# a separate layer (deploy/lambda/layer.sh) because it is a native binary.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=dist-lambda
rm -rf "$OUT"
mkdir -p "$OUT/config"

npx esbuild deploy/lambda/handler.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$OUT/index.js" \
  --log-level=warning

# The config file is read at runtime by loadConfig() via AFE_CONFIG_PATH; ship it beside the
# bundle so the function is self-contained (no S3 fetch, no network read for policy).
cp config/config.json "$OUT/config/config.json"

cd "$OUT"
zip -qr function.zip index.js config
echo "built $OUT/function.zip ($(du -h function.zip | cut -f1))"
