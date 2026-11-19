#!/usr/bin/env bash
# install-browser.sh — 给台子装一份浏览器，**不需要 root**。
#
# 为什么不用 apt：WSL/容器里装 Chromium 常常走 snap（WSL 里跑不起来）或要 sudo 密码；
# Chrome for Testing 是官方 CI 用的独立构建，解开就能跑，装完还能给别的项目当测试浏览器。
#
#   ./install-browser.sh            # 装到 ~/.local/rig-browsers/
#   ./install-browser.sh 158.0.1.2  # 指定版本
#
# 装完把最后打印的那行 export 留着，或直接：
#   RIG_BROWSER=<路径> node rig.mjs run --tag lb --scenario smoke
set -euo pipefail

ver="${1:-}"
if [ -z "$ver" ]; then
  ver=$(curl -s --max-time 30 https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).channels.Stable.version)})')
fi

# chrome-for-testing 的平台名和 uname -m 不是一回事：aarch64 → linux-arm64（踩过：拿 linux64 的包，
# 解压一切正常，执行时才报 "可执行文件格式错误"）。
case "$(uname -m)" in
  aarch64|arm64) plat=linux-arm64 ;;
  x86_64|amd64)  plat=linux64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 2 ;;
esac

base="$HOME/.local/rig-browsers"
dest="$base/chrome-$ver-$plat"
bin="$dest/chrome-$plat/chrome"
mkdir -p "$base"

if [ ! -x "$bin" ]; then
  url="https://storage.googleapis.com/chrome-for-testing-public/$ver/$plat/chrome-$plat.zip"
  tmp="$base/chrome-$ver-$plat.zip"
  echo "downloading $url"
  curl -fL --retry 3 --max-time 1800 -o "$tmp" "$url"
  rm -rf "$dest"; mkdir -p "$dest"
  unzip -q "$tmp" -d "$dest"
  rm -f "$tmp"
fi
chmod +x "$bin"

echo "browser: $bin"
"$bin" --version || { echo "binary did not run (arch mismatch? see uname -m = $(uname -m))" >&2; exit 1; }
echo
echo "用法： RIG_BROWSER=$bin node rig.mjs run --tag linux --scenario smoke"
echo "（容器/CI 里若报 sandbox 相关错误，加 RIG_EXTRA_ARGS=\"--no-sandbox\"）"
