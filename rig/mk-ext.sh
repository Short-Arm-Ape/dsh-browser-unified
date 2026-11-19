#!/bin/bash
# mk-ext.sh <pristine|fixed|asis> <rigTag> <manifestVersion> [srcExtensionDir]
#
# 保留旧的调用形状，实体在 rig.mjs（可移植；不再写死 WSL 绝对路径）。
#   pristine/fixed：拿 rig/upstream-head 里的上游快照（fixed 额外打 apply-fix-D.mjs）
#   asis：整份拷贝一个现成的扩展目录（例如 src/extension）
# 注入两件事：端口钉到 stub（默认 9781）、hello 帧带 rigTag。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:?usage: mk-ext.sh <pristine|fixed|asis> <rigTag> <version> [srcExtensionDir]}"
tag="${2:?rigTag}"; ver="${3:?manifestVersion}"
args=(build --from "$mode" --tag "$tag" --ver "$ver")
if [ "${4:-}" != "" ]; then args+=(--src "$4"); fi
exec node "$here/rig.mjs" "${args[@]}"
