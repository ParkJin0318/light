/**
 * 데몬이 사람 대신 보내는 「이어 가라」 턴의 문장.
 * 모델에는 데스크톱 앱과 같은 영어 문장을, 화면에는 무슨 일인지 한국어로 보인다. 턴의 출처는 `auto-continuation` 이다
 */

/** 데몬이 꺼진 사이 멈춘 턴(데스크톱 `maybeRunQuitAutoResume`) */
export const QUIT_CONTINUATION = {
  prompt: "The app was quit while you were working. Please continue from where you left off.",
  display: "Mac 의 light 가 꺼진 사이 멈춘 작업을 이어 갑니다.",
} as const;

/** Mac 이 잠든 사이 끊긴 턴(데스크톱 `runSleepAutoResume`) */
export const SLEEP_CONTINUATION = {
  prompt: "My computer went to sleep while you were working. Please continue from where you left off.",
  display: "Mac 이 잠든 사이 끊긴 작업을 이어 갑니다.",
} as const;

const DISPLAY = new Map<string, string>([QUIT_CONTINUATION, SLEEP_CONTINUATION].map((entry) => [entry.prompt, entry.display]));

/** 기록에서 읽은 사람 줄이 데몬이 보낸 이어 가기 턴이면 그 화면 문장 */
export function autoContinuationDisplay(text: string): string | undefined {
  return DISPLAY.get(text.trim());
}
