#!/bin/bash
# teardown.sh — 杀掉台子起来的浏览器与 stub，并报告端口是否释放。
#
# 只杀命令行里带**本台子工作目录**的进程，绝不碰你日常用的 Edge/Chrome。
# 保留旧调用形状；实体在 rig.mjs。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/rig.mjs" down
