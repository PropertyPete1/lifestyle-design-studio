#!/usr/bin/env bash
# Fetch the selfie segmentation model the PIP feature needs.
#
# The model is vendored in assets/models/ so renders are deterministic and do
# not depend on a download at build time — the same argument as the vendored map
# geometry. This script exists to refresh it, and for a clean checkout that
# somehow lacks it.
#
# 244 KB, from Google's official model host. See longform/probe/PIP-SEGMENTATION.md.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/assets/models/selfie_segmenter.tflite"
URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
mkdir -p "$(dirname "$DEST")"
curl -fsSL -o "$DEST" "$URL"
echo "wrote $DEST ($(wc -c < "$DEST") bytes)"
