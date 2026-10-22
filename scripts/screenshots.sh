#!/bin/sh
# README 스크린샷 — 데모 데몬을 띄워 PWA 와 Mac 설정 창을 찍고 docs/images 에 쓴다. claude 는 띄우지 않는다.
#   처음 한 번: npx playwright install chromium
#   데이터:     LIGHT_DEMO_DIR(기본 .dev/screenshots)
#   포트:       LIGHT_DEMO_PORT(기본 47699) — 쓰던 데몬(47615)과 섞지 않는다
set -eu
cd "$(dirname "$0")/.."
export LIGHT_DEMO_DIR="${LIGHT_DEMO_DIR:-$PWD/.dev/screenshots}"
export LIGHT_DEMO_PORT="${LIGHT_DEMO_PORT:-47699}"
npm run build -w pwa
npm run tokens -w mac
mkdir -p "$LIGHT_DEMO_DIR"
log="$LIGHT_DEMO_DIR/daemon.log"
bun scripts/screenshots/demo-daemon.ts >"$log" 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT INT TERM
# 세션 셋이 답을 기다리는 자리에 서면 데몬이 ready 를 찍는다
tries=0
until grep -q '^ready' "$log" 2>/dev/null; do
  if ! kill -0 "$daemon" 2>/dev/null; then
    cat "$log"
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "데모 데몬이 60초 안에 준비되지 않았습니다. $log 를 보십시오."
    exit 1
  fi
  sleep 0.5
done
node scripts/screenshots/capture.mjs
