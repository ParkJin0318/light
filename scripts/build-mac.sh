#!/bin/sh
# Mac 앱 빌드 — PWA 를 짓고, 데몬을 bun 실행 파일 하나로 묶고, Electron 앱으로 싼다.
#   번들 ID:   LIGHT_BUNDLE_ID(기본 dev.light.mac) — 코드에 박지 않는다
#   서명·공증: CSC_NAME(Developer ID Application 인증서 이름)과 APPLE_ID·APPLE_APP_SPECIFIC_PASSWORD·APPLE_TEAM_ID 가 있을 때만
#   자체 서명: 그 둘이 없고 LIGHT_SIGN_IDENTITY(인증서 SHA-1)가 있으면 그 신원으로 서명만 한다(키체인은 LIGHT_SIGN_KEYCHAIN). 없으면 ad-hoc
#   대상:      TARGET(기본 dmg, 확인용은 dir)
#   업데이트:  LIGHT_RELEASE_REPO(owner/name) — 주면 번들에 그 레포의 릴리스 주소를 싣고 mac/release/ 에 zip 과 업데이트 명세(light-update.json)를 남긴다.
#              이것이 실린 번들만 새 버전을 받는다(mac/src/update.ts). CI 는 release 브랜치에서만 준다
set -eu
cd "$(dirname "$0")/.."
npm run build -w pwa
mkdir -p .build
bun build --compile --minify daemon/src/main.ts --outfile .build/light-daemon

# 빌드 정보 — 번들의 Contents/Resources/build.json 이 되고 앱의 업데이트가 읽는다. 키는 mac/src/update.ts 의 BuildStamp 와 같다
STAMP_VERSION="$(node -p "require('./mac/package.json').version")" STAMP_REPO="${LIGHT_RELEASE_REPO:-}" \
STAMP_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)" \
STAMP_COMMITTED_AT="$(TZ=UTC0 git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
node -e '
const e = process.env;
const stamp = { version: e.STAMP_VERSION };
if (e.STAMP_COMMIT) stamp.commit = e.STAMP_COMMIT;
if (e.STAMP_COMMITTED_AT) stamp.committedAt = e.STAMP_COMMITTED_AT;
if (e.STAMP_REPO) stamp.releases = `https://github.com/${e.STAMP_REPO}/releases`;
console.log(JSON.stringify(stamp));
' > .build/build.json

npm run build -w mac
cd mac
set -- --mac "${TARGET:-dmg}" "-c.appId=${LIGHT_BUNDLE_ID:-dev.light.mac}"
if [ -n "${CSC_NAME:-}" ] && [ -n "${APPLE_ID:-}" ]; then
  set -- "$@" -c.mac.notarize=true
else
  # 서명을 건너뛰면(null) 링커 서명만 남아 번들 봉인이 없다 — 업데이트가 받은 번들의 봉인을 대조하므로 적어도 ad-hoc 으로 서명한다.
  # "-" 만 주면 키체인의 다른 신원으로 서명할 수 있어 훅이 신원을 고정한다(mac/build/sign.js)
  if [ -n "${LIGHT_SIGN_IDENTITY:-}" ]; then
    echo "자체 서명 인증서($LIGHT_SIGN_IDENTITY)로 서명합니다. 공증은 하지 않습니다."
  else
    echo "서명 인증서·공증 자격 증명이 없어 ad-hoc 서명 빌드를 만듭니다."
  fi
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  set -- "$@" -c.mac.identity=- -c.mac.sign=./build/sign.js
fi
npx electron-builder "$@"

[ -n "${LIGHT_RELEASE_REPO:-}" ] || exit 0
ARCH="$(node -p process.arch)"
# electron-builder 는 x64 를 mac/, 나머지를 mac-<arch>/ 에 둔다
if [ "$ARCH" = x64 ]; then APP="release/mac/light.app"; else APP="release/mac-$ARCH/light.app"; fi
[ -d "$APP" ] || { echo "$APP 이 없습니다 — electron-builder 의 출력 자리가 바뀌었는지 보십시오" >&2; exit 1; }
VERSION="$(node -p "require('./package.json').version")"
ZIP="light-$VERSION-$ARCH.zip"
rm -f release/*.zip release/light-update.json
# ditto 로 묶는다 — Electron 번들의 심볼릭 링크와 확장 속성이 그대로 남아야 서명이 산다
ditto -c -k --sequesterRsrc --keepParent "$APP" "release/$ZIP"
# 번들의 빌드 정보 + 올릴 zip. 키는 mac/src/update.ts 의 ReleaseManifest 와 같다
MANIFEST_TAG="v$VERSION" MANIFEST_ASSET="$ZIP" MANIFEST_ARCH="$ARCH" \
MANIFEST_SHA256="$(shasum -a 256 "release/$ZIP" | cut -d' ' -f1)" MANIFEST_SIZE="$(stat -f %z "release/$ZIP")" \
node -e '
const e = process.env;
const stamp = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const key of ["commit", "committedAt", "releases"]) if (stamp[key] === undefined) throw new Error(`빌드 정보에 ${key} 가 없습니다`);
console.log(JSON.stringify({ ...stamp, tag: e.MANIFEST_TAG, asset: e.MANIFEST_ASSET, arch: e.MANIFEST_ARCH, sha256: e.MANIFEST_SHA256, size: Number(e.MANIFEST_SIZE) }, null, 2));
' "$APP/Contents/Resources/build.json" > release/light-update.json
echo "업데이트 명세: mac/release/light-update.json · mac/release/$ZIP"
