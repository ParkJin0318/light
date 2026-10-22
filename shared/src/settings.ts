/**
 * Mac 앱 설정 — 데몬이 `settings.json` 에 쥐고 Mac 앱이 로컬 API 로 고친다.
 * 경로·호스트 이름은 코드에 박지 않고 여기 둔다. 저장된 설정에 키를 더할 때는 기본값을 둔다
 */
import { z } from "zod";
import { EFFORT_LEVELS, PERMISSION_MODES } from "./protocol.ts";

export const settingsSchema = z.object({
  /** 새 세션 후보로 보일 프로젝트 폴더 */
  projectFolders: z.array(z.string()).default([]),
  /** 기본 모델 — 비우면 claude 설정을 따른다 */
  defaultModel: z.string().optional(),
  /** 기본 노력도 — 비우면 claude 설정(`effortLevel`)과 모델 기본값을 따른다 */
  defaultEffort: z.enum(EFFORT_LEVELS).optional(),
  defaultPermissionMode: z.enum(PERMISSION_MODES).default("default"),
  /** 접속을 허용할 tailnet 로그인 — 비어 있으면 serve 로 들어온 요청을 모두 막는다 */
  allowedLogins: z.array(z.string()).default([]),
  /** 이 Mac 의 브라우저가 127.0.0.1 로 바로 여는 것을 허용한다(개발, 위협 모델 밖의 로컬 프로세스) */
  allowLocalhost: z.boolean().default(true),
  /** 알림 종류 */
  notifications: z.object({
    permission: z.boolean().default(true),
    question: z.boolean().default(true),
    turnDone: z.boolean().default(true),
    error: z.boolean().default(true),
  }).prefault({}),
  /** 잠금 화면에서 본문을 감춘다 — 프로젝트 이름과 이벤트 종류만 */
  hideLockScreenBody: z.boolean().default(false),
  /** 로그인 시 실행·세션이 도는 동안 잠자기 막기 — Mac 앱이 읽는다 */
  launchAtLogin: z.boolean().default(false),
  preventSleep: z.boolean().default(true),
  /** 유휴 세션의 프로세스를 닫는 시간(분) */
  idleCloseMinutes: z.number().int().min(1).max(24 * 60).default(30),
  /** 새 세션이 빨리 첫 답을 내도록 claude 프로세스 하나를 예열해 둔다 */
  prewarm: z.boolean().default(true),
  /** 동시 세션 상한 — 비우면 `max(6, 메모리 / 3GiB)` */
  maxConcurrentSessions: z.number().int().min(1).max(64).optional(),
  /** 턴 도구 — 할 일 띠와 턴 끝의 「다음 단계」 상자·답 단추를 세션이 쥔다. 상자의 요약이 턴 완료 알림의 본문이 된다 */
  turnTools: z.boolean().default(true),
  /** 데몬이 꺼지거나 Mac 이 잠든 사이 끊긴 턴을 다시 띄워 이어 가게 한다(데스크톱 앱과 같은 문장·한도) */
  autoContinue: z.boolean().default(true),
  /** 폰에서 보낸 글을 터미널의 입력 이력(`~/.claude/history.jsonl`)에도 남긴다 — 터미널의 ↑ 가 그 글을 부른다 */
  writePromptHistory: z.boolean().default(true),
  /**
   * 인증 — `subscription` 은 claude 에 로그인한 계정을 그대로 쓰고 셸의 ANTHROPIC_API_KEY 를 넘기지 않는다.
   * `apiKey` 는 로그인 셸 env 의 ANTHROPIC_API_KEY 를 넘긴다. light 는 키를 저장하지 않는다
   */
  authMode: z.enum(["subscription", "apiKey"]).default("subscription"),
  /** claude 실행 파일 — 비우면 로그인 셸 PATH 에서 찾는다 */
  claudePath: z.string().optional(),
  /** 데몬이 127.0.0.1 에서 받는 포트 */
  port: z.number().int().min(1024).max(65535).default(47615),
});

export type LightSettings = z.infer<typeof settingsSchema>;

export function defaultSettings(): LightSettings {
  return settingsSchema.parse({});
}
