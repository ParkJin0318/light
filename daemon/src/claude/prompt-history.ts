/**
 * 터미널의 입력 이력(`~/.claude/history.jsonl`) — 터미널의 ↑·Ctrl+R 이 읽는 파일.
 * SDK 세션은 이 파일에 쓰지 않는다(실측: SDK 세션 94개 모두 0줄). 그래서 폰에서 보낸 글을 터미널과 같은 줄로 더해
 * Mac 터미널에서 다시 부를 수 있게 한다. 줄 모양은 터미널 것 그대로다: `{display, pastedContents, timestamp, project, sessionId}`.
 * 슬래시 명령과 `!` 명령도 친 그대로 남긴다(터미널과 같다). light 에는 접은 붙여넣기가 없어 `pastedContents` 는 늘 비어 있다
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PromptHistoryEntry {
  display: string;
  project: string;
  sessionId: string;
  /** epoch 밀리초 */
  timestamp: number;
}

/** 한 줄을 더한다 — 한 번의 쓰기로 붙여 다른 프로세스(터미널)의 줄과 섞이지 않게 한다 */
export function appendPromptHistory(claudeHome: string, entry: PromptHistoryEntry): void {
  const path = join(claudeHome, "history.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const record = { display: entry.display, pastedContents: {}, timestamp: entry.timestamp, project: entry.project, sessionId: entry.sessionId };
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
