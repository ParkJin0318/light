#!/bin/sh
# 개발용 데몬 — 데이터는 레포의 .dev/ 에 둔다(설치본의 ~/Library/Application Support/light 와 섞지 않는다)
cd "$(dirname "$0")/.." || exit 1
export LIGHT_HOME="${LIGHT_HOME:-$PWD/.dev/light-home}"
exec bun daemon/src/main.ts
