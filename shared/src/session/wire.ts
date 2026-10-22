/**
 * Agent SDK 메시지 해석.
 * SDK 메시지는 CLI 통신 메시지를 파싱한 객체 그대로다. 형식 근거는 실측 픽스처(`shared/test/fixtures`)다.
 * 모르는 줄은 `unknown` 으로 흘려보내고 던지지 않는다 — 해석 실패 하나로 세션 화면이 멈추면 안 된다.
 * 시각은 epoch 밀리초다
 */
import { jarr, jbool, jget, jint, jnum, jstr, jstrings, type JSONValue } from "./json-value.ts";

export type WireInbound =
  | { kind: "systemInit"; info: WireSessionInit }
  /** init 밖 system 이벤트(status·task_*·compact_boundary·api_retry·hook_*…) */
  | { kind: "system"; subtype: string; payload: JSONValue }
  | { kind: "assistant"; message: WireMessage }
  | { kind: "user"; message: WireMessage }
  | { kind: "streamEvent"; event: WireStreamEvent; parentToolUseID?: string }
  | { kind: "result"; result: WireTurnResult }
  | { kind: "rateLimit"; status: string; utilization?: number; resetsAt?: number; rateLimitType?: string }
  /** 다음 사람 턴의 예측 — `promptSuggestions` 를 켠 세션에서 `result` 뒤에 */
  | { kind: "promptSuggestion"; text: string }
  | { kind: "unknown" };

export function decodeInbound(json: JSONValue): WireInbound {
  switch (jstr(jget(json, "type"))) {
    case "system": {
      const subtype = jstr(jget(json, "subtype")) ?? "";
      if (subtype === "init") return { kind: "systemInit", info: decodeSessionInit(json) };
      return { kind: "system", subtype, payload: json };
    }
    case "assistant":
    case "user": {
      const message = decodeMessage(json);
      if (message === undefined) return { kind: "unknown" };
      return jstr(jget(json, "type")) === "assistant" ? { kind: "assistant", message } : { kind: "user", message };
    }
    case "stream_event": {
      const event = jget(json, "event");
      if (event === undefined) return { kind: "unknown" };
      const parentToolUseID = jstr(jget(json, "parent_tool_use_id"));
      return { kind: "streamEvent", event: decodeStreamEvent(event), ...(parentToolUseID !== undefined ? { parentToolUseID } : {}) };
    }
    case "result":
      return { kind: "result", result: decodeTurnResult(json) };
    case "prompt_suggestion":
      return { kind: "promptSuggestion", text: jstr(jget(json, "suggestion")) ?? "" };
    // 서브에이전트 재시도 — 도구 카드를 고치는 system 이벤트로 넘긴다
    case "tool_progress":
      return { kind: "system", subtype: "tool_progress", payload: json };
    // /clear·계획 승인의 컨텍스트 비우기 — 화면은 새 대화로 간다
    case "conversation_reset":
      return { kind: "system", subtype: "conversation_reset", payload: json };
    case "rate_limit_event": {
      const info = jget(json, "rate_limit_info");
      if (info === undefined) return { kind: "unknown" };
      const utilization = jnum(jget(info, "utilization"));
      const resetsAt = jnum(jget(info, "resetsAt"));
      const rateLimitType = jstr(jget(info, "rateLimitType"));
      return {
        kind: "rateLimit", status: jstr(jget(info, "status")) ?? "",
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(rateLimitType !== undefined ? { rateLimitType } : {}),
      };
    }
    default:
      return { kind: "unknown" };
  }
}

/** `system/init` — 턴마다 다시 온다(모델·권한 모드 변경이 여기로 반영된다) */
export interface WireSessionInit {
  sessionID?: string;
  model?: string;
  permissionMode?: string;
  slashCommands: string[];
  cliVersion?: string;
  cwd?: string;
  fastMode?: WireFastMode;
  /**
   * 다음 요청의 노력도. `null` 은 노력도를 싣지 않는다는 뜻이고 키가 없으면 모른다 —
   * d.ts 는 Remote Control 의 init 에만 싣는다고 적었다(SDK 세션은 `get_settings` 로 읽는다)
   */
  effort?: string | null;
}

/** 빠른 모드 — SDK 경로는 플래그 층에 `fastMode` 가 없으면 `sdk_opt_in_required` 로 막는다(실측) */
export interface WireFastMode {
  state: string;
  disabledReason?: string;
}

function decodeFastMode(json: JSONValue): WireFastMode | undefined {
  const state = jstr(jget(json, "fast_mode_state"));
  if (state === undefined) return undefined;
  const disabledReason = jstr(jget(json, "fast_mode_disabled_reason"));
  return { state, ...(disabledReason !== undefined ? { disabledReason } : {}) };
}

function decodeSessionInit(json: JSONValue): WireSessionInit {
  const effort = jget(json, "effort");
  const fastMode = decodeFastMode(json);
  return {
    sessionID: jstr(jget(json, "session_id")),
    model: jstr(jget(json, "model")),
    permissionMode: jstr(jget(json, "permissionMode")),
    slashCommands: jstrings(jget(json, "slash_commands")),
    cliVersion: jstr(jget(json, "claude_code_version")),
    cwd: jstr(jget(json, "cwd")),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(effort === null || typeof effort === "string" ? { effort } : {}),
  };
}

/** assistant·user 메시지 — assistant 는 블록마다 따로 오고 같은 `message.id` 를 공유한다 */
export interface WireMessage {
  messageID?: string;
  content: WireContentBlock[];
  parentToolUseID?: string;
  /** `--replay-user-messages` 의 되돌림 — 이미 화면에 낸 사람 입력이다 */
  isReplay: boolean;
  /**
   * 메타 줄(명령 확장·첨부·스킬 본문). 기록은 `isMeta`, 통신은 `isSynthetic` 으로 온다.
   * 통신의 `isSynthetic` 은 메타·기록 전용·압축 요약을 한 플래그로 뭉친 값이라 압축으로 읽지 않는다
   */
  isMeta: boolean;
  /** 기록의 압축 요약 — 사람 말이 아니라 압축 구분선으로 그린다 */
  isCompactSummary: boolean;
  /** 기록의 `origin.kind` — 사람 턴은 `human`, 백그라운드 완료 통지는 `task-notification`. 옛 기록과 통신엔 없다 */
  origin?: string;
  /** API 호출이 실패해 CLI 가 대신 적은 줄 — 모델의 답이 아니다 */
  isApiError: boolean;
  /** `message.model` 이 `<synthetic>` — CLI 가 만든 자리표시 줄 */
  isSyntheticModel: boolean;
  usage?: WireUsage;
  /** 도구 결과의 구조화 메타 — 통신은 `tool_use_result`, 기록은 `toolUseResult` */
  toolUseResult?: JSONValue;
  timestamp?: number;
  uuid?: string;
}

function decodeMessage(json: JSONValue): WireMessage | undefined {
  const message = jget(json, "message");
  if (message === undefined) return undefined;
  const rawContent = jget(message, "content");
  const content: WireContentBlock[] = typeof rawContent === "string"
    ? [{ kind: "text", text: rawContent }]
    : Array.isArray(rawContent) ? rawContent.map(decodeContentBlock) : [];
  const usage = jget(message, "usage");
  const timestampText = jstr(jget(json, "timestamp"));
  const timestamp = timestampText === undefined ? undefined : Date.parse(timestampText);
  return {
    messageID: jstr(jget(message, "id")),
    content,
    parentToolUseID: jstr(jget(json, "parent_tool_use_id")),
    isReplay: jbool(jget(json, "isReplay")) ?? false,
    isMeta: jbool(jget(json, "isMeta")) === true || jbool(jget(json, "isSynthetic")) === true,
    isCompactSummary: jbool(jget(json, "isCompactSummary")) === true,
    origin: jstr(jget(json, "origin", "kind")),
    isApiError: jbool(jget(json, "isApiErrorMessage")) === true || jstr(jget(json, "error")) !== undefined,
    isSyntheticModel: jstr(jget(message, "model")) === "<synthetic>",
    usage: usage === undefined ? undefined : decodeUsage(usage),
    toolUseResult: jget(json, "tool_use_result") ?? jget(json, "toolUseResult"),
    timestamp: timestamp === undefined || Number.isNaN(timestamp) ? undefined : timestamp,
    uuid: jstr(jget(json, "uuid")),
  };
}

export type WireContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolUse"; id: string; name: string; input: JSONValue }
  | { kind: "toolResult"; toolUseID: string; content: string; isError: boolean; images: WireImageBlock[] }
  /** 사람 턴에 붙은 이미지 — 기록 재생에서 온다(통신은 보낸 턴을 되돌려 주지 않는다) */
  | { kind: "image"; image: WireImageBlock }
  /** 사람 턴에 붙은 문서(PDF) — 본문은 풀지 않고 이름만 */
  | { kind: "document"; title: string }
  | { kind: "other"; type: string };

/** base64 image 블록 — 본문은 풀지 않고 그대로 든다 */
export interface WireImageBlock {
  mediaType: string;
  data: string;
}

function decodeImage(json: JSONValue): WireImageBlock | undefined {
  if (jstr(jget(json, "source", "type")) !== "base64") return undefined;
  const data = jstr(jget(json, "source", "data"));
  if (data === undefined || data === "") return undefined;
  return { mediaType: jstr(jget(json, "source", "media_type")) ?? "image/png", data };
}

function decodeContentBlock(json: JSONValue): WireContentBlock {
  const type = jstr(jget(json, "type"));
  switch (type) {
    case "text":
      return { kind: "text", text: jstr(jget(json, "text")) ?? "" };
    case "thinking":
      return { kind: "thinking", text: jstr(jget(json, "thinking")) ?? "" };
    case "redacted_thinking":
      return { kind: "thinking", text: "" };
    case "tool_use":
    case "server_tool_use":
      return { kind: "toolUse", id: jstr(jget(json, "id")) ?? "", name: jstr(jget(json, "name")) ?? "", input: jget(json, "input") ?? {} };
    case "tool_result":
      return {
        kind: "toolResult", toolUseID: jstr(jget(json, "tool_use_id")) ?? "",
        content: flattenResult(jget(json, "content")),
        isError: jbool(jget(json, "is_error")) ?? false,
        images: (jarr(jget(json, "content")) ?? []).flatMap((block) => {
          const image = jstr(jget(block, "type")) === "image" ? decodeImage(block) : undefined;
          return image === undefined ? [] : [image];
        }),
      };
    case "image": {
      const image = decodeImage(json);
      return image === undefined ? { kind: "other", type: "image" } : { kind: "image", image };
    }
    case "document":
      return { kind: "document", title: jstr(jget(json, "title")) ?? "문서.pdf" };
    default:
      return { kind: "other", type: type ?? "" };
  }
}

/** tool_result 본문은 문자열이거나 블록 배열이다 — 글만 잇고 이미지는 표식으로 */
function flattenResult(content: JSONValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    switch (jstr(jget(block, "type"))) {
      case "text": {
        const text = jstr(jget(block, "text"));
        if (text !== undefined) parts.push(text);
        break;
      }
      case "image":
        parts.push("[이미지]");
        break;
      case "tool_reference": {
        const name = jstr(jget(block, "tool_name"));
        if (name !== undefined) parts.push(`[도구 ${name}]`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}

export interface WireUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

function decodeUsage(json: JSONValue): WireUsage {
  return {
    inputTokens: jint(jget(json, "input_tokens")) ?? 0,
    cacheCreationTokens: jint(jget(json, "cache_creation_input_tokens")) ?? 0,
    cacheReadTokens: jint(jget(json, "cache_read_input_tokens")) ?? 0,
    outputTokens: jint(jget(json, "output_tokens")) ?? 0,
  };
}

/** 이 요청이 모델에 실은 컨텍스트 크기 — 캐시 적중분도 컨텍스트다 */
export function usageContextTokens(usage: WireUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

/** `includePartialMessages` 의 원시 API 이벤트 — 화면은 이걸로 글자 단위로 흐른다 */
export type WireStreamEvent =
  | { kind: "messageStart"; messageID?: string }
  | { kind: "blockStart"; index: number; block: WireContentBlock }
  | { kind: "textDelta"; index: number; text: string }
  | { kind: "thinkingDelta"; index: number; text: string }
  | { kind: "inputJSONDelta"; index: number; partialJSON: string }
  | { kind: "other" };

function decodeStreamEvent(json: JSONValue): WireStreamEvent {
  const index = jint(jget(json, "index")) ?? 0;
  switch (jstr(jget(json, "type"))) {
    case "message_start": {
      const messageID = jstr(jget(json, "message", "id"));
      return { kind: "messageStart", ...(messageID !== undefined ? { messageID } : {}) };
    }
    case "content_block_start":
      return { kind: "blockStart", index, block: decodeContentBlock(jget(json, "content_block") ?? null) };
    case "content_block_delta": {
      const delta = jget(json, "delta");
      switch (jstr(jget(delta, "type"))) {
        case "text_delta":
          return { kind: "textDelta", index, text: jstr(jget(delta, "text")) ?? "" };
        case "thinking_delta":
          return { kind: "thinkingDelta", index, text: jstr(jget(delta, "thinking")) ?? "" };
        case "input_json_delta":
          return { kind: "inputJSONDelta", index, partialJSON: jstr(jget(delta, "partial_json")) ?? "" };
        default:
          return { kind: "other" };
      }
    }
    default:
      return { kind: "other" };
  }
}

export interface WireTurnResult {
  subtype: string;
  isError: boolean;
  sessionID?: string;
  /** 세션 누적값이다(턴 값이 아니다 — 실측) */
  totalCostUSD?: number;
  durationMS?: number;
  resultText?: string;
  /** 이 턴의 값이다 */
  usage?: WireUsage;
  /** 모델 턴 수 — 모델을 부르지 않은 결과는 0 이다 */
  numTurns?: number;
  fastMode?: WireFastMode;
}

function decodeTurnResult(json: JSONValue): WireTurnResult {
  const usage = jget(json, "usage");
  const fastMode = decodeFastMode(json);
  return {
    ...(fastMode !== undefined ? { fastMode } : {}),
    subtype: jstr(jget(json, "subtype")) ?? "",
    isError: jbool(jget(json, "is_error")) ?? false,
    sessionID: jstr(jget(json, "session_id")),
    totalCostUSD: jnum(jget(json, "total_cost_usd")),
    durationMS: jint(jget(json, "duration_ms")),
    resultText: jstr(jget(json, "result")),
    usage: usage === undefined ? undefined : decodeUsage(usage),
    numTurns: jint(jget(json, "num_turns")),
  };
}
