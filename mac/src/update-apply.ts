/**
 * 갈아 끼우기 — 앱이 내려간 뒤 받아 둔 번들을 설치본 자리로 옮긴다. 앱이 끝날 때 `update.ts` 가 떼어 띄운다.
 *
 * 앱이 직접 할 수 없다: 데몬은 그 번들 안의 실행 파일로 돌고 앱보다 늦게 내려간다. 그래서 새 세션으로 띄운 셸이
 * 앱과 데몬이 둘 다 끝나기를 기다린 뒤 옮긴다. 셸은 이 파일의 글을 `zsh -c` 로 받는다 — 번들 안의 스크립트 파일을 돌리면
 * 그 파일이 든 번들을 옮기게 된다.
 *
 * 1분 안에 내려가지 않으면 옮기지 않고 받아 둔 것을 남긴다(다음에 끌 때 다시 한다). 옮기다 실패하면 옛 번들을 되돌려 놓는다.
 * 데이터 폴더는 건드리지 않는다
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface ApplyPlan {
  appPID: number;
  /** 데몬이 떠 있지 않았으면 없다 */
  daemonPID: number | undefined;
  /** 받은 빌드를 두는 자리 — 그 안의 `staged/<이름>.app` 을 옮긴다 */
  directory: string;
  /** 설치본 — 지금 도는 번들 */
  target: string;
  /** 갈아 끼운 뒤 띄운다 — [다시 시작해 업데이트]를 누른 직후다 */
  relaunch: boolean;
  /** 0.1초씩 몇 번 기다릴지 */
  waitTicks?: number;
}

/** 0.1초 × 600 = 1분 — 데몬은 stdin 이 닫히면 세션을 닫고 끝난다 */
const WAIT_TICKS = 600;

// Bun 의 String.raw 는 한글을 `\uXXXX` 날글자로 남긴다 — 보통 템플릿으로 쓰고 글 안에 `${` 와 역슬래시를 두지 않는다
const SCRIPT = `
set -u
app_pid=$1 daemon_pid=$2 dir=$3 target=$4 relaunch=$5 ticks=$6
alive() { kill -0 $app_pid 2>/dev/null || { (( daemon_pid > 0 )) && kill -0 $daemon_pid 2>/dev/null } }
for (( i = 0; i < ticks; i++ )); do alive || break; sleep 0.1; done
if alive; then print -r -- "앱이 내려가지 않아 바꾸지 않았습니다"; exit 1; fi

staged=( $dir/staged/*.app(N/) )
(( $#staged == 1 )) || { print -r -- "받아 둔 빌드가 없습니다: $dir/staged"; exit 1; }

previous=$dir/previous.app
rm -rf "$previous"
mv "$target" "$previous" || { print -r -- "설치본을 옮기지 못했습니다: $target"; exit 1; }
if ! mv "$staged[1]" "$target"; then
  mv "$previous" "$target"
  print -r -- "새 빌드를 놓지 못해 옛 번들을 되돌렸습니다"
  exit 1
fi
rm -rf "$previous" "$dir/staged"
print -r -- "바꿨습니다: $target"
[[ $relaunch == 1 ]] && open "$target"
exit 0
`;

/**
 * 떼어 띄울 명령 — 인자는 셸의 위치 인자로 넘긴다(글에 끼워 넣지 않는다).
 * 로케일을 박는다 — Finder 로 띄운 앱의 환경에는 LANG 이 없을 수 있고 로그의 한글 줄이 그 로케일을 따른다
 */
export function applyCommand(plan: ApplyPlan): { executable: string; args: string[] } {
  return {
    executable: "/usr/bin/env",
    args: [
      "LC_ALL=en_US.UTF-8", "/bin/zsh", "-c", SCRIPT, "light-update",
      String(plan.appPID), String(plan.daemonPID ?? 0), plan.directory, plan.target,
      plan.relaunch ? "1" : "0", String(plan.waitTicks ?? WAIT_TICKS),
    ],
  };
}

/** 새 세션으로 띄우고 놓는다 — 앱이 내려가도 산다. 출력은 로그 파일 하나에 덮어쓴다 */
export function detach(executable: string, args: string[], logPath: string): void {
  const log = openSync(logPath, "w");
  try {
    spawn(executable, args, { detached: true, stdio: ["ignore", log, log] }).unref();
  } finally {
    closeSync(log);
  }
}
