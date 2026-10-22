#!/bin/sh
# Mac 앱 빌드 — PWA 를 짓고, 데몬을 bun 실행 파일 하나로 묶고, Electron 앱으로 싼다.
#   번들 ID:   LIGHT_BUNDLE_ID(기본 dev.light.mac) — 코드에 박지 않는다
#   서명·공증: CSC_NAME(Developer ID Application 인증서 이름)과 APPLE_ID·APPLE_APP_SPECIFIC_PASSWORD·APPLE_TEAM_ID 가 있을 때만
#   대상:      TARGET(기본 dmg, 확인용은 dir)
set -eu
cd "$(dirname "$0")/.."
npm run build -w pwa
mkdir -p .build
bun build --compile --minify daemon/src/main.ts --outfile .build/light-daemon
npm run build -w mac
cd mac
set -- --mac "${TARGET:-dmg}" "-c.appId=${LIGHT_BUNDLE_ID:-dev.light.mac}"
if [ -n "${CSC_NAME:-}" ] && [ -n "${APPLE_ID:-}" ]; then
  set -- "$@" -c.mac.notarize=true
else
  echo "서명 인증서·공증 자격 증명이 없어 서명하지 않은 빌드를 만듭니다."
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  set -- "$@" -c.mac.identity=null
fi
npx electron-builder "$@"
