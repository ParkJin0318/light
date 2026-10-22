/**
 * light 가 대신 처리하는 입력 — SDK 세션에서는 CLI 가 받지 않는 터미널의 명령을 데몬이 같은 일로 바꾼다.
 *
 * - `/btw <질문>`: 곁가지 질문. 도는 턴을 끊지 않고 도구 없이 답하며 대화에 남지 않는다(`askSideQuestion`). 글로 보내면
 *   「/btw isn't available in this environment.」로 끝난다(2026-10-22 실측)
 * - `/fork <지시>`·`/subtask <지시>`: 대화 전체를 물려받은 fork 에이전트를 백그라운드로 띄운다. 터미널이 직접 띄우는 함수는
 *   호스트 제어 요청에 없어 모델에게 같은 에이전트(Agent 도구의 `subagent_type: "fork"`)를 띄우라고 보낸다 — 모델 턴 하나가 더 든다
 * - `/background`: 도는 포그라운드 도구를 백그라운드로 넘긴다(터미널의 Ctrl+B, `backgroundTasks`)
 * - `! <명령>`: 셸 모드. 데몬이 그 폴더에서 돌리고 입력·출력을 터미널과 같은 줄로 기록에 붙인다(`shouldQuery: false`)
 */

export type NativeCommand =
  | { kind: "btw"; question: string }
  | { kind: "fork"; name: "fork" | "subtask"; directive: string }
  | { kind: "background" }
  | { kind: "shell"; command: string };

/** 자동 완성에 더할 명령 — CLI 가 알린 목록(`slash_commands`)에는 없다 */
export const NATIVE_SLASH_COMMANDS = ["btw", "fork", "subtask", "background"] as const;

export function parseNativeCommand(text: string): NativeCommand | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("!")) return { kind: "shell", command: trimmed.slice(1).trim() };
  const match = /^\/(btw|fork|subtask|background)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  const rest = (match[2] ?? "").trim();
  switch (match[1]) {
    case "btw": return { kind: "btw", question: rest };
    case "background": return rest === "" ? { kind: "background" } : undefined;
    default: return { kind: "fork", name: match[1] as "fork" | "subtask", directive: rest };
  }
}

const FORK_HEAD = "Fork yourself to handle the directive below: call the Agent tool with subagent_type \"fork\", a short description, and the directive as the prompt. Do not wait for it or do the work yourself; reply only that it was launched.\n\nDirective: ";

/** `/fork` 를 모델에게 보낼 글 — 실측: Agent{subagent_type:"fork"} 를 부르고 턴을 바로 끝낸 뒤 완료 통지에 후속 턴이 결과를 알린다 */
export function forkDirectivePrompt(directive: string): string {
  return `${FORK_HEAD}${directive}`;
}

/** 기록의 사람 줄이 fork 지시면 사람이 친 모양(`/fork 지시`) */
export function forkDirectiveDisplay(text: string): string | undefined {
  return text.startsWith(FORK_HEAD) ? `/fork ${text.slice(FORK_HEAD.length).trim()}` : undefined;
}
