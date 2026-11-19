#!/bin/bash
# mk-ext-unified.sh <srcExtensionDir> <rigTag> <manifestVersion>
#
# 旧名字，保留给已经在用的手顺：等价于 rig.mjs build --from asis。
# （unified 线的扩展会自己扫端口，rig 只把 DEFAULT_PORT 钉到 stub、注入 rigTag。）
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/rig.mjs" build --from asis --src "${1:?src extension dir}" --tag "${2:?rigTag}" --ver "${3:?version}"
