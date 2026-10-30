#!/bin/bash
# mk-ext-unified.sh <srcExtensionDir> <rigTag> <manifestVersion>
#
# Same idea as mk-ext.sh, but for the *unified* extension line (dsh-browser-unified),
# which differs from the upstream one in two ways that matter to the rig:
#   - it auto-discovers the bridge port (probe `GET /api/status` over 9777..9786),
#     so the rig pins DEFAULT_PORT=9781 = the stub, and the stub serves /api/status;
#   - its hello frame carries `extensionId` instead of upstream's `protocol:` field,
#     so the rig tag is injected next to that anchor.
#
# Refuses to proceed when an anchor is missing (a silently-unpatched copy would
# produce "evidence" for a build that is not the one under test).
set -euo pipefail
src="${1:?src extension dir}"; tag="${2:?tag}"; ver="${3:?version}"
rig=/home/wsluser/projects/dsh-browser-unified/rig
out="$rig/ext-$tag"
rm -rf "$out"; mkdir -p "$out"
cp -r "$src"/. "$out/"
[ -d "$out/icons" ] || cp "$rig"/icons/*.png "$out/icons/"

python3 - "$out" "$tag" "$ver" <<'PY'
import json, sys
out, tag, ver = sys.argv[1], sys.argv[2], sys.argv[3]

mp = out + '/manifest.json'
d = json.loads(open(mp, 'rb').read().decode('utf-8-sig'))
d['version'] = ver
d['name'] = d.get('name', '') + ' [RIG ' + tag + ']'
open(mp, 'w', encoding='utf-8', newline='').write(json.dumps(d, ensure_ascii=False, indent='\t'))

bp = out + '/background.js'
s = open(bp, encoding='utf-8').read()
s2 = s.replace('const DEFAULT_PORT = 9777;', 'const DEFAULT_PORT = 9781; // RIG-ONLY (live bridge is 9777)', 1)
assert s2 != s, 'port anchor missing'
# 锚点用 hello 帧里最稳的那一段：`client: 'dsh-browser-extension',`（两边都有，
# 而它后面的字段我们加过 protocol/extensionId，写整行会随源码演进失效）。
anchor = "client: 'dsh-browser-extension',"
assert anchor in s2, 'hello anchor missing'
s3 = s2.replace(anchor, anchor + f" rigTag: '{tag}',", 1)
open(bp, 'w', encoding='utf-8', newline='').write(s3)
print(f'{out}: version={ver} rigTag={tag}')
PY

node --check "$out/background.js"
echo "  DEFAULT_PORT 命中: $(grep -c 'DEFAULT_PORT = 9781' "$out/background.js")  rigTag 命中: $(grep -c "rigTag: '$tag'" "$out/background.js")"
echo "built $out"
