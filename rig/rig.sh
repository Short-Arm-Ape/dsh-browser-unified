#!/usr/bin/env bash
# rig.sh — Linux/macOS 入口。真正的实现在 rig.mjs（两个平台同一份逻辑）。
# 用法：./rig.sh run --tag linux --scenario smoke
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/rig.mjs" "$@"
