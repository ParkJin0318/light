// Developer ID 가 없을 때의 서명 훅 — scripts/build-mac.sh 가 건다.
// LIGHT_SIGN_IDENTITY(자체 서명 인증서의 SHA-1)가 있으면 그 신원으로 서명한다. 지정 요건이 인증서에 묶여 업데이트 뒤에도
// macOS 권한(전체 디스크 접근·폴더 접근)이 남는다. 신뢰 사슬이 없어 신원 검증(find-identity -v)을 건너뛰고 Apple 타임스탬프도 쓰지 않는다.
// 없으면 ad-hoc 이다 — 지정 요건이 cdhash 라 빌드마다 바뀌어 권한이 풀린다.
// electron-builder 는 identity "-" 를 받으면 키체인에서 이름에 "-" 가 든 신원부터 찾아 그것으로 서명한다
// (app-builder-lib 의 MacTargetHelper.findSigningIdentity). 그 신원은 버리고 옵션(엔타이틀먼트·데몬 실행 파일)만 쓴다
const { signAsync } = require("@electron/osx-sign");

exports.sign = (options) => {
  const identity = process.env.LIGHT_SIGN_IDENTITY;
  if (identity) return signAsync({ ...options, identity, identityValidation: false, keychain: process.env.LIGHT_SIGN_KEYCHAIN || undefined, timestamp: "none" });
  return signAsync({ ...options, identity: "-", keychain: undefined });
};
