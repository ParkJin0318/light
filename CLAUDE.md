# light

## 목적 (WHY)

Mac 에서 도는 Claude Code 세션을 아이폰·아이패드의 PWA 채팅으로 시작하고 이어받고 승인하는 도구다.
폰과 Mac 은 사용자의 tailnet 안에서만 이어지고(tailscale serve) 중계 서버는 없다.

## 구조 (WHAT)

| 경로 | 내용 |
|---|---|
| `shared/` | 순수 TS. 프로토콜(zod)·설정 모델·SDK 메시지 해석·대화 모델과 리듀서·대기 요청·기록 갈래 고르기 |
| `daemon/` | Bun. 세션 수명(`query()`)·권한 중계·폰 명령·되감기·자동 이어 가기·Mac 기록 읽기·HTTP/WS API·PWA 서빙·웹 푸시·첨부·로컬 API |
| `pwa/` | React + Vite. 화면 전부와 서비스 워커(`pwa/public/sw.js`) |
| `mac/` | Electron 메뉴바 앱. 데몬 감시·상태·설정·온보딩·업데이트. 화면은 `mac/ui/` 바닐라 JS, 토큰은 PWA 의 `tokens.css` 를 빌드 때 복사한다 |
| `scripts/` | 개발 데몬(`dev-daemon.sh`)·Mac 앱 빌드(`build-mac.sh`)·아이콘 그리기(`make-icons.ts`)·README 스크린샷(`screenshots.sh`, 가짜 `query()` 데모 데몬) |

## 작동 (HOW)

- 데몬이 정본이다. 세션마다 리듀서(`shared/src/session/conversation.ts:217`)를 돌리고 바뀐 항목만 순번 붙은 패치로 보낸다(`daemon/src/session/channel.ts:69`). 기록 재생과 실시간이 같은 리듀서다
- 권한·질문·계획은 전부 `canUseTool`(`daemon/src/session/live-session.ts:950`)로 와서 카드가 되고, 답은 `decisionFor`(`shared/src/session/pending.ts:255`)가 SDK 응답으로 바꾼다
- 모든 요청은 `gate`(`daemon/src/security.ts:50`)를 지난다. serve 로 온 요청은 `Tailscale-User-Login` 허용 목록, 상태를 바꾸는 요청은 Origin 검사, `/local/*` 는 데이터 폴더 토큰
- SDK 옵션은 `sessionOptions`(`daemon/src/session/options.ts`) 한 곳에서 만든다. 노력도·빠른 모드·막은 MCP 서버는 세션 플래그 층 하나에, 훅·턴 도구·덧붙이는 프롬프트는 세션 확장(`daemon/src/session/extensions.ts`) 하나의 규칙으로 싣는다. 시스템 프롬프트는 기록하지 않는다(`snapshot: false`). 터미널과 다르게 정해지는 기동 값(`.mcp.json` 승인·Bash 시한·사고 표시·Chrome)은 `daemon/src/session/terminal-parity.ts`, 예열은 `daemon/src/session/spare.ts`
- Mac 앱 업데이트는 앱이 한다(`mac/src/update.ts`). release 브랜치 빌드만 번들의 `build.json` 에 릴리스 주소를 싣고, 최신 릴리스의 `light-update.json` 으로 새 버전을 받아 체크섬·서명·빌드 정보를 대조해 두었다가 앱을 끌 때 떼어 띄운 셸이 갈아 끼운다(`mac/src/update-apply.ts`). 서명 요건은 신원이 있으면 지정 요건, ad-hoc 이면 번들 ID 다

검사

- 의존 설치는 루트 `npm install`. 시험은 `bun test`, 타입은 `npm run typecheck`, PWA 는 `npm run build`
- 화면을 고쳤으면 `npm run build` 뒤 미리보기(`.claude/launch.json` 의 light, 데이터는 `.dev/`)로 확인한다
- Mac 앱은 `npm run mac`. 시험 모드 `LIGHT_SMOKE=1`(+`LIGHT_SMOKE_SHOT`·`LIGHT_SMOKE_CRASH`·`LIGHT_SMOKE_HANG`)이 상태를 찍고 끝난다
- CI(`.github/workflows/mac.yml`)는 `scripts/build-mac.sh` 를 그대로 돌려 dmg 를 올리고 release 브랜치면 `mac/package.json` 의 version 으로 릴리스(dmg·zip·업데이트 명세)를 낸다(있는 버전은 건너뛴다). 스크립트의 env 를 바꾸면 워크플로도 맞춘다
- 인증서 없는 빌드도 ad-hoc 으로 서명한다(`mac/build/adhoc-sign.js`). 서명을 건너뛰면 번들 봉인이 없어 업데이트가 그 빌드를 받지 않는다
- 실제 claude 로 확인할 때는 haiku 와 스크래치 폴더를 쓰고 `LIGHT_HOME` 을 따로 둔다

어기면 안 되는 것

- claude 바이너리는 사용자가 설치한 것을 수정 없이 띄운다. OAuth 토큰·키체인을 읽거나 넘기지 않고 로그인 화면을 만들지 않는다
- 데몬은 127.0.0.1 에만 바인드한다. Funnel 이 켜져 있으면 로컬 API 만 답한다
- 살아 있는 세션을 그대로 resume 하지 않는다 — 레지스트리로 판정하고 fork 나 가져오기를 고르게 한다(`daemon/src/session/manager.ts:455`)
- 세션 폴더는 동기로 읽기 전에 `FolderAccess`(`daemon/src/folder-access.ts`)를 지난다. macOS 허용 창이 동기 open() 을 붙잡으면 HTTP 까지 데몬 전체가 멈춘다
- 가져오기의 신호는 claude pid 하나에만 보낸다(`daemon/src/claude/termination.ts:57`). 부모 셸에 보내면 터미널 창이 닫힌다
- 경로·호스트 이름·번들 ID 는 코드에 박지 않는다. 설정(`shared/src/settings.ts`)이나 env 로 받는다
- 저장 파일에 키를 더할 때는 없어도 되는 키로 둔다. 필수로 두면 기존 행이 조용히 사라진다
- SDK 판은 고정한다(`daemon/package.json`). 올리면 `shared/test/fixtures` 픽스처 시험과 실제 세션 확인을 다시 한다
