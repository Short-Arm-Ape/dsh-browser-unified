#!/bin/bash
# __pr-d-rig/probe.sh — drive one nav/tabs.open scenario against the rig stub.
# usage: probe.sh <label>
set -u
LABEL="${1:?label}"
OUT="/home/wsluser/projects/dsh-browser-unified/rig/evidence-${LABEL}.txt"
CTL=http://127.0.0.1:9781/ctl/cmd
BASE=http://localhost:9781

call() { # call <json-body> [max-time]
  curl -s --max-time "${2:-45}" -X POST -d "$1" "$CTL"
}

{
  echo "=== scenario ${LABEL} @ $(date -Is) ==="
  echo "--- 0. baseline: land the active tab on /fast"
  call "{\"command\":\"nav\",\"params\":{\"url\":\"$BASE/fast\"}}"; echo
  sleep 1

  echo "--- 1. GROUND TRUTH before: tabs.list"
  call '{"command":"tabs.list","params":{}}'; echo

  echo "--- 2. nav -> /slow?ms=3000 (a page whose load takes 3 s)"
  call "{\"command\":\"nav\",\"params\":{\"url\":\"$BASE/slow?ms=3000\"}}"; echo

  echo "--- 3. GROUND TRUTH 4 s later: where did the tab really land?"
  sleep 4
  call '{"command":"tabs.list","params":{}}'; echo

  echo "--- 4. tabs.open -> /slow?ms=3000"
  call "{\"command\":\"tabs.open\",\"params\":{\"url\":\"$BASE/slow?ms=3000\"}}"; echo

  echo "--- 5. GROUND TRUTH 4 s later: tabs.list"
  sleep 4
  call '{"command":"tabs.list","params":{}}'; echo

  echo "--- 6. cleanup: close every tab except the first"
  call '{"command":"tabs.list","params":{}}' | python3 -c 'import json,sys; d=json.load(sys.stdin)["result"]; print(json.dumps([t["id"] for t in d["tabs"][1:]]))' > /tmp/rig-close.json
  EXTRA=$(cat /tmp/rig-close.json)
  echo "closing tabIds=$EXTRA"
  for id in $(echo "$EXTRA" | tr -d '[]' | tr ',' ' '); do
    call "{\"command\":\"tabs.close\",\"params\":{\"tabId\":$id}}"; echo
  done
  echo "=== end ${LABEL} ==="
} 2>&1 | tee "$OUT"
