#!/bin/bash
# probe.sh <label> — 一个最小真机场景：导航到慢页，用扩展自己的 eval 读回页面真实状态
# （ground truth），而不是相信 nav 的回执。写到 rig/evidence-<label>.txt。
#
# 保留旧调用形状；实体在 rig.mjs。前置：stub 与浏览器都已就绪（rig.mjs up）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/rig.mjs" probe "${1:-probe}" --port "${RIG_PORT:-9781}"
