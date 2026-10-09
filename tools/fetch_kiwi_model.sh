#!/usr/bin/env bash
# Kiwi 형태소 분석 모델을 models/kiwi/ 에 받는다 (약 110MB, 저장소에는 올리지 않는다).
#   bash tools/fetch_kiwi_model.sh
# kiwi-nlp(npm) 버전과 모델 버전은 맞춰야 한다.
set -euo pipefail
VER="${KIWI_VERSION:-0.24.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/models/kiwi"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSLf -o "$TMP/model.tgz" \
  "https://github.com/bab2min/Kiwi/releases/download/v${VER}/kiwi_model_v${VER}_base.tgz"
tar xzf "$TMP/model.tgz" -C "$TMP"
mkdir -p "$DEST"
cp "$TMP"/models/cong/base/* "$DEST/"
echo "Kiwi 모델 v${VER} → $DEST"
