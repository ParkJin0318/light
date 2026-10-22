/**
 * 리듀서 항목 → 화면 항목. 폰으로 가는 양을 줄인다 — 도구 입력·출력 원문은 앞부분만, 결과 메타는 요약 줄에만 쓴다
 */
import type { SessionLifecycle, ViewItem } from "../protocol.ts";
import type { ConversationItem, ConversationModel } from "./conversation.ts";
import type { JSONValue } from "./json-value.ts";
import { isPermissionPending, pendingCategory, type PendingInteraction } from "./pending.ts";
import { toolSummary } from "./tool-summary.ts";
import { WRAP_UP_FULL_NAME, wrapUpContent } from "./turn-box.ts";

/** 원문 한 칸의 상한(글자) */
const VIEW_TEXT_LIMIT = 20_000;

function clip(text: string): { text: string; clipped: boolean } {
  return text.length > VIEW_TEXT_LIMIT ? { text: `${text.slice(0, VIEW_TEXT_LIMIT)}\n…`, clipped: true } : { text, clipped: false };
}

/** 대기 요청의 긴 입력(Write 의 본문 등)은 화면에 앞부분만 — 원문은 펼쳐 볼 만큼 */
export function clipPending(pending: PendingInteraction): PendingInteraction {
  if (!isPermissionPending(pending)) return pending;
  return { ...pending, request: { ...pending.request, input: clipJSON(pending.request.input) } } as PendingInteraction;
}

function clipJSON(value: JSONValue): JSONValue {
  if (typeof value === "string") return clip(value).text;
  if (Array.isArray(value)) return value.map(clipJSON);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clipJSON(inner)]));
  return value;
}

export function toViewItem(item: ConversationItem, cwd?: string): ViewItem {
  const base: ViewItem = {
    id: item.id, kind: item.content.kind,
    ...(item.parentToolUseID !== undefined ? { parentToolUseID: item.parentToolUseID } : {}),
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.finishedAt !== undefined ? { finishedAt: item.finishedAt } : {}),
  };
  const content = item.content;
  switch (content.kind) {
    case "user":
      return {
        ...base, text: content.text,
        ...(item.images !== undefined ? { images: item.images } : {}), ...(item.files !== undefined ? { files: item.files } : {}),
        ...(item.snippets !== undefined ? { snippets: item.snippets } : {}),
      };
    case "assistant":
    case "thinking":
      return { ...base, text: content.text, isStreaming: content.isStreaming };
    case "notice":
      return { ...base, notice: content.notice };
    case "tool": {
      const call = content.call;
      const summary = toolSummary(call.name, call.input, call.resultMeta, cwd);
      const rawInput = call.state === "composing" ? call.partialInput : JSON.stringify(call.input, null, 2) ?? "";
      const input = clip(rawInput);
      const result = call.result === undefined ? undefined : clip(call.result);
      const wrapUp = call.name === WRAP_UP_FULL_NAME && call.state !== "composing" ? wrapUpContent(call.input) : undefined;
      return {
        ...base,
        tool: {
          toolUseID: call.toolUseID, name: call.name, title: summary.title, line: summary.line, state: call.state,
          input: input.text,
          ...(result !== undefined ? { result: result.text } : {}),
          ...(input.clipped || result?.clipped === true ? { truncated: true } : {}),
          ...(call.subagent !== undefined ? { subagent: call.subagent } : {}),
          ...(call.resultImages !== undefined ? { resultImages: call.resultImages } : {}),
          ...(wrapUp !== undefined ? { wrapUp } : {}),
        },
      };
    }
  }
}

/**
 * 빠른 모드를 못 켜는 까닭(SDK `FastModeDisabledReason`) — 켜 봐도 소용없는 까닭만 글로 준다.
 * `sdk_opt_in_required` 는 플래그 층에 켜면 풀리고 `pending` 은 아직 확인 중이라 막지 않는다
 */
export function fastModeBlockedText(reason: string | undefined): string | undefined {
  switch (reason) {
    case "free": return "무료 요금제에서는 빠른 모드를 쓰지 못합니다.";
    case "preference": return "claude 설정에서 빠른 모드를 꺼 두었습니다.";
    case "extra_usage_disabled": return "계정의 추가 사용량이 꺼져 있어 빠른 모드를 쓰지 못합니다.";
    case "network_error": return "빠른 모드를 확인하지 못했습니다(네트워크 오류). 잠시 뒤 다시 켜 보십시오.";
    case "not_first_party": return "Anthropic API 가 아닌 제공자에서는 빠른 모드를 쓰지 못합니다.";
    case "disabled_by_env": return "env 설정이 빠른 모드를 꺼 두었습니다.";
    case "model_not_allowed": return "이 모델은 빠른 모드를 지원하지 않습니다.";
    case "unknown": return "빠른 모드를 쓸 수 없는 상태입니다.";
    default: return undefined;
  }
}

/**
 * 목록의 상태 — 대기 요청이 있으면 그 갈래, 턴이 돌면 실행 중, 프로세스가 살아 있으면 유휴.
 * `alive`: 프로세스가 떠 있다. `starting`: 띄우는 중. `failed`: 띄우지 못했거나 오류로 끝났다
 */
export function lifecycleOf(model: ConversationModel, process: { alive: boolean; starting: boolean; failed: boolean }): SessionLifecycle {
  if (process.starting) return "starting";
  if (model.pending.length > 0) {
    return model.pending.some((pending) => pendingCategory(pending) === "permission") ? "waitingPermission" : "waitingQuestion";
  }
  if (process.alive && (model.status.isTurnActive || model.status.isCompacting)) return "running";
  if (process.alive) return "idle";
  return process.failed ? "error" : "closed";
}
