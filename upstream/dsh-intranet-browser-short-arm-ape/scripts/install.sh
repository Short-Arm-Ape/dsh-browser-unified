#!/usr/bin/env bash
# dsh-intranet-browser one-click installer for DeepSeek Harness (macOS / Linux)
# Manually installs THIS local package (no npm publish needed) into the `web` profile:
#   - builds the package (tsc + client bundle) if sources changed
#   - runs `dsh plugin --profile web add file:<this repository root>`
#   - migrates the legacy `@yeesy369/dsh-intranet-browser` entry if one exists
#
# Usage:
#   bash scripts/install.sh
#
# Prerequisites: Node.js + pnpm (dsh plugin itself requires pnpm) and the dsh CLI.

set -euo pipefail

# --- locate this package ------------------------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
echo "[dsh-intranet-browser] Package root: $repo_root"

# --- prerequisites ------------------------------------------------------------
if ! command -v dsh >/dev/null 2>&1; then
  echo "[dsh-intranet-browser] dsh CLI not found." >&2
  echo "" >&2
  echo "  Check:    dsh --version" >&2
  echo "  Install:  npm i -g @deepseek-ai/dsh" >&2
  echo "  Website:  https://www.npmjs.com/package/@deepseek-ai/dsh" >&2
  echo "" >&2
  echo "  After installing, open a NEW terminal window and run this script again." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[dsh-intranet-browser] pnpm not found on PATH — dsh plugin management needs it." >&2
  echo "  Install:  npm i -g pnpm" >&2
  exit 1
fi

# --- build if sources are newer than the emitted lib/ --------------------------
need_build=false
if [ ! -f "$repo_root/lib/index.js" ]; then
  need_build=true
else
  lib_time="$(stat -c %Y "$repo_root/lib/index.js" 2>/dev/null || stat -f %m "$repo_root/lib/index.js")"
  while IFS= read -r -d '' f; do
    src_time="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"
    if [ "$src_time" -gt "$lib_time" ]; then
      need_build=true
      break
    fi
  done < <(find "$repo_root/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0)
fi
if [ "$need_build" = true ]; then
  echo "[dsh-intranet-browser] Building the package (pnpm install + pnpm build)..."
  (cd "$repo_root" && pnpm install && pnpm build)
else
  echo "[dsh-intranet-browser] lib/ is up to date, skipping build."
fi

# --- install into the web profile (manual / local-path install) ----------------
echo "[dsh-intranet-browser] Installing into the web profile..."
dsh plugin --profile web add "file:$repo_root"

# --- migrate the legacy package name if present --------------------------------
profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/web"
manifest="$profile_dir/package.json"
if [ -f "$manifest" ]; then
  if grep -q '"@yeesy369/dsh-intranet-browser"' "$manifest"; then
    echo "[dsh-intranet-browser] Removing the legacy @yeesy369/dsh-intranet-browser entry..."
    if ! dsh plugin --profile web remove @yeesy369/dsh-intranet-browser; then
      echo "[dsh-intranet-browser] WARNING: could not remove the legacy entry (the running dsh instance may lock its files)." >&2
      echo "  After restarting dsh web, run:  dsh plugin --profile web remove @yeesy369/dsh-intranet-browser" >&2
    fi
  fi
fi

# --- verify --------------------------------------------------------------------
ok=false
if [ -f "$manifest" ]; then
  if grep -q '"@short-arm-ape/dsh-intranet-browser"' "$manifest" &&
     [ -f "$profile_dir/node_modules/@short-arm-ape/dsh-intranet-browser/lib/index.js" ]; then
    ok=true
  fi
fi
if [ "$ok" = true ]; then
  echo "[dsh-intranet-browser] Verified: @short-arm-ape/dsh-intranet-browser is registered in the web profile."
else
  echo "[dsh-intranet-browser] WARNING: verification failed — check the profile manifest at:" >&2
  echo "  $manifest" >&2
fi

echo ""
echo "[dsh-intranet-browser] Done! Restart your profile to load the new build:"
echo "  1) Ctrl+C the running \`dsh web\`, then run \`dsh web\` again."
echo "  2) The AI gets the intranet_* tools; every call asks for approval (per call by default)."
echo "  3) Logins persist in ~/.dsh/intranet-edge-profile (independent of the regular browser)."
