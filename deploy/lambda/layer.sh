#!/usr/bin/env bash
# Builds the difftastic Lambda layer: dist-lambda/layer.zip with bin/difft.
# Version and checksum are PINNED here to the same values the container image uses (Dockerfile),
# so the two deployment shapes can never diff with different difftastic versions. A checksum
# mismatch aborts the build rather than shipping an unverified binary.
set -euo pipefail
cd "$(dirname "$0")/../.."

DIFFT_VERSION=0.69.0
DIFFT_ARCH=x86_64-unknown-linux-gnu
DIFFT_SHA256=038db96a0e8fce69f2554e33e04ff75fbf6f96ea45cb4edb9ed6203a2c4750ff

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -fsSL -o "$WORK/difft.tar.gz" \
  "https://github.com/Wilfred/difftastic/releases/download/${DIFFT_VERSION}/difft-${DIFFT_ARCH}.tar.gz"

ACTUAL=$(shasum -a 256 "$WORK/difft.tar.gz" | cut -d' ' -f1)
if [ "$ACTUAL" != "$DIFFT_SHA256" ]; then
  echo "FATAL: difftastic checksum mismatch (expected $DIFFT_SHA256, got $ACTUAL)" >&2
  exit 1
fi

mkdir -p "$WORK/bin" dist-lambda
tar -xzf "$WORK/difft.tar.gz" -C "$WORK" difft
install -m 0755 "$WORK/difft" "$WORK/bin/difft"
( cd "$WORK" && zip -qr layer.zip bin )
mv "$WORK/layer.zip" dist-lambda/layer.zip
echo "built dist-lambda/layer.zip ($(du -h dist-lambda/layer.zip | cut -f1)) — difftastic ${DIFFT_VERSION} ${DIFFT_ARCH}"
