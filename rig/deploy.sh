#!/bin/bash
# deploy.sh <rigTag> — 让浏览器跑起 ext-<rigTag> 这份构建。
#
# 保留旧调用形状；实体在 rig.mjs。它做的事和三件事的顺序没变：
#   1. 用**全新 profile**（旧 profile 会静默继续跑旧的 background.js）；
#   2. 起浏览器（默认 headless，加 --windowed 改成有窗口）；
#   3. 等到 hello 帧真的报出这个 rigTag 才返回 —— 否则报错退出，不把假证据交出去。
#
# 注意：stub 先起着（rig.mjs stub / up）。deploy 只管浏览器那一半。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tag="${1:?usage: deploy.sh <rigTag> [--windowed]}"
shift || true
exec node "$here/rig.mjs" up --tag "$tag" --reuse "$@"
