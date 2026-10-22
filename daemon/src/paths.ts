/**
 * 데몬이 쓰는 경로 — 코드에 박지 않고 env 로 바꿀 수 있게 둔다.
 * `LIGHT_HOME` 이 데이터 폴더, `LIGHT_CLAUDE_HOME` 이 claude 의 홈(`~/.claude`)이다. 시험은 둘 다 임시 폴더로 돌린다
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface LightPaths {
  /** `~/Library/Application Support/light` */
  data: string;
  settings: string;
  state: string;
  devices: string;
  vapid: string;
  localToken: string;
  /** Mac 앱이 읽는 상태 한 장 — 데몬이 꺼져 있어도 마지막 이유가 남는다 */
  status: string;
  uploads: string;
  logs: string;
  pushLog: string;
  /** `~/.claude` */
  claudeHome: string;
  /** PWA 빌드 결과 */
  pwaDist: string;
  home: string;
}

export function lightPaths(env: Readonly<Record<string, string | undefined>> = process.env): LightPaths {
  const home = env.HOME ?? homedir();
  const data = env.LIGHT_HOME ?? join(home, "Library", "Application Support", "light");
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
  return {
    data,
    settings: join(data, "settings.json"),
    state: join(data, "state.json"),
    devices: join(data, "devices.json"),
    vapid: join(data, "vapid.json"),
    localToken: join(data, "local-token"),
    status: join(data, "status.json"),
    uploads: join(data, "uploads"),
    logs: join(data, "logs"),
    pushLog: join(data, "logs", "push.jsonl"),
    claudeHome: env.LIGHT_CLAUDE_HOME ?? join(home, ".claude"),
    pwaDist: env.LIGHT_PWA_DIST ?? join(repoRoot, "pwa", "dist"),
    home,
  };
}
