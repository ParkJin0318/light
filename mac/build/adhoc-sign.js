// 인증서 없는 빌드의 서명 훅 — 늘 ad-hoc 으로 서명한다. scripts/build-mac.sh 가 인증서가 없을 때만 건다.
// electron-builder 는 identity "-" 를 받으면 키체인에서 이름에 "-" 가 든 신원부터 찾아 그것으로 서명한다
// (app-builder-lib 의 MacTargetHelper.findSigningIdentity). 그 신원은 버리고 옵션(엔타이틀먼트·데몬 실행 파일)만 쓴다
const { signAsync } = require("@electron/osx-sign");

exports.sign = (options) => signAsync({ ...options, identity: "-", keychain: undefined });
