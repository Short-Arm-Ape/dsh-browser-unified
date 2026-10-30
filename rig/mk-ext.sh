#!/bin/bash
# mk-ext.sh <pristine|fixed|asis> <rigTag> <manifestVersion> [srcExtensionDir]
# Build a rig-only copy of an extension:
#   - port 9777 -> 9781 (never touch the user's live bridge)
#   - a `rigTag` in the hello frame + a bumped manifest version, so the browser
#     tells us WHICH background.js it is running (a stale profile otherwise
#     silently keeps the old script and poisons the evidence)
#   - `pristine`/`fixed` take upstream HEAD from /home/wsluser/projects/dsh-browser-unified/rig/upstream-head
#     (`fixed` applies apply-fix-D.mjs); `asis` copies a whole extension dir
#     (4th arg) unchanged — used to test a *current* tree, e.g. __pr-E/work/extension
set -euo pipefail
mode="${1:?mode}"; tag="${2:?tag}"; ver="${3:?version}"
up=/home/wsluser/projects/dsh-browser-unified/rig/upstream-head
rig=/home/wsluser/projects/dsh-browser-unified/rig
out="$rig/ext-$tag"
rm -rf "$out"; mkdir -p "$out/icons"

if [ "$mode" = asis ]; then
  src="${4:?asis needs a source extension dir}"
  cp -r "$src"/. "$out/"
  [ -d "$out/icons" ] || cp "$rig"/icons/*.png "$out/icons/"
else
  cp "$up/extension__background.js" "$out/background.js"
  cp "$up/extension__manifest.json" "$out/manifest.json"
  cp "$up/extension__popup.js" "$out/popup.js"
  cp "$up/extension__popup.html" "$out/popup.html"
  cp "$rig"/icons/*.png "$out/icons/"
  if [ "$mode" = fixed ]; then node "$rig/apply-fix-D.mjs" "$out/background.js"; fi
fi

python3 - "$out" "$tag" "$ver" <<'PY'
import json, sys
out, tag, ver = sys.argv[1], sys.argv[2], sys.argv[3]
mp = out + '/manifest.json'
d = json.loads(open(mp, 'rb').read().decode('utf-8-sig'))
d['version'] = ver
open(mp, 'w', encoding='utf-8', newline='').write(json.dumps(d, ensure_ascii=False, indent='\t'))
bp = out + '/background.js'
s = open(bp, encoding='utf-8').read()
s2 = s.replace('const DEFAULT_PORT = 9777;', 'const DEFAULT_PORT = 9781; // RIG-ONLY (live bridge is 9777)', 1)
assert s2 != s, 'port anchor missing'
s3 = s2.replace("protocol: PROTOCOL_VERSION, browser: helloInfo", f"protocol: PROTOCOL_VERSION, rigTag: '{tag}', browser: helloInfo", 1)
assert s3 != s2, 'hello anchor missing'
open(bp, 'w', encoding='utf-8', newline='').write(s3)
print(f'{out}: version={ver} rigTag={tag}')
PY

node --check "$out/background.js"
# 只看这一版的差异指纹：新增的批量关闭命令 + 宿主侧字段（旧版应为 0）
echo "  cmdTabsCloseMany 命中: $(grep -c 'cmdTabsCloseMany' "$out/background.js")   tabs.closeMany 注册: $(grep -c "'tabs.closeMany'" "$out/background.js")"
echo "built $out"
