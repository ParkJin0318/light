/**
 * 세션 화면 한 장의 상태와 그 리듀서.
 * 데몬이 살아 있는 세션의 SDK 메시지와 기록 파일 재생을 같은 리듀서로 먹이고, 화면은 그 항목을 그린다.
 *
 * 리듀서는 모델을 제자리에서 고치되 **항목 객체는 고치지 않고 새 객체로 갈아 끼운다** — 데몬이 앞 스냅샷과
 * 참조만 견줘 바뀐 항목을 찾는다(`diffItems`). 항목을 지우거나 대화를 비우면 `structure` 가 오른다.
 *
 * 블록 정체성: assistant 메시지는 블록마다 따로 오고 `message.id` 를 공유한다. 스트리밍 블록은
 * `<messageID>:<index>`, 최종 블록은 같은 메시지에서 도착한 순번으로 같은 id 를 만들어 덮는다
 * (실측: 최종 이벤트 순서 = content_block index 순서). 도구 블록은 tool_use id 가 정체성이다
 */
import { splitAttachments, type AttachedSnippet } from "./attachments.ts";
import { autoContinuationDisplay } from "./auto-continuation.ts";
import { forkDirectiveDisplay } from "./commands.ts";
import { jarr, jbool, jget, jint, jstr, type JSONValue } from "./json-value.ts";
import { pendingToolUseID, type PendingInteraction } from "./pending.ts";
import { UPDATE_PLAN_FULL_NAME, WRAP_UP_FULL_NAME, applyPlanUpdate, completePlan, wrapUpContent, type TurnWrapUp } from "./turn-box.ts";
import { usageContextTokens, type WireInbound, type WireMessage, type WireStreamEvent } from "./wire.ts";

export interface ConversationModel {
  items: ConversationItem[];
  pending: PendingInteraction[];
  /** TaskCreate·TaskUpdate(신형)와 TodoWrite(구형)를 한 목록으로 모은다 */
  tasks: TaskEntry[];
  status: ConversationStatus;
  /** 턴 도중에 보낸 글 — 턴이 끝나면 한 턴으로 묶어 보낸다 */
  queued: QueuedMessage[];
  /** 바뀔 때마다 오른다 */
  revision: number;
  /** 항목을 지우거나 비웠을 때 오른다 — 덧붙이기·갈아 끼우기만으로는 오르지 않는다 */
  structure: number;

  indexByID: Map<string, number>;
  streamingMessageID?: string;
  streamingBlockIDs: Map<number, string>;
  finalizedBlockCount: Map<string, number>;
  /** 서브에이전트 task_id → Agent 도구의 tool_use id(task_updated 는 task_id 만 준다) */
  toolIDByTaskID: Map<string, string>;
  /** 이미지 본문(id → base64) — 항목에는 참조만 싣고 본문은 화면이 따로 묻는다 */
  images: Map<string, StoredImage>;
  /** 사람에게 물은 도구 호출 — 그 거부는 사람이 한 것이라 자동 거부 줄을 남기지 않는다 */
  askedToolIDs: Set<string>;
}

export interface StoredImage {
  mediaType: string;
  /** base64 */
  data: string;
}

export interface ImageRef {
  id: string;
  mediaType: string;
}

export interface TaskEntry {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** 업로드 id — 보낼 때 데몬이 이미지 블록·`@"경로"` 로 바꾼다 */
  attachments: string[];
  /** 맥락으로 붙인 인용 */
  snippets?: AttachedSnippet[];
}

/** 살아 있는 백그라운드 작업 하나(`system/background_tasks_changed` 의 한 줄) */
export interface BackgroundTask {
  id: string;
  /** `local_agent`·`local_bash` 등(실측) */
  type?: string;
  description?: string;
}

/** 빠른 모드 — `state` 는 off·on·cooldown, 못 켜는 까닭은 `disabledReason` */
export interface FastModeStatus {
  state: string;
  disabledReason?: string;
}

/** 컨텍스트 창 — `get_context_usage` summary 의 `maxTokens`·`autoCompactThreshold` */
export interface ContextWindow {
  max: number;
  autoCompactAt?: number;
}

export type ConversationContent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; isStreaming: boolean }
  | { kind: "thinking"; text: string; isStreaming: boolean }
  | { kind: "tool"; call: ToolCall }
  | { kind: "notice"; notice: Notice };

export interface ConversationItem {
  id: string;
  /** 서브에이전트 안에서 나온 항목이면 그 Agent 도구의 tool_use id */
  parentToolUseID?: string;
  content: ConversationContent;
  startedAt?: number;
  finishedAt?: number;
  /** 사람 메시지에 붙은 이미지 */
  images?: ImageRef[];
  /** 사람 메시지 글머리의 `@"경로"` 를 뗀 파일 */
  files?: string[];
  /** 사람 메시지 글머리의 인용(`<!-- attach -->`) */
  snippets?: AttachedSnippet[];
}

export type ToolCallState = "composing" | "running" | "awaitingDecision" | "succeeded" | "failed";

export interface ToolCall {
  toolUseID: string;
  name: string;
  input: JSONValue;
  /** `input_json_delta` 누적 — 입력이 완성되기 전 미리보기 */
  partialInput: string;
  result?: string;
  /** 결과의 구조화 메타(`tool_use_result`) — patch·파일 범위·할 일 id */
  resultMeta?: JSONValue;
  resultImages?: ImageRef[];
  state: ToolCallState;
  subagent?: SubagentProgress;
}

export interface SubagentProgress {
  description?: string;
  activity?: string;
  status?: string;
  summary?: string;
  toolUses?: number;
  isBackgrounded?: boolean;
}

/** `shell` 은 `!` 셸 줄의 출력(화면은 고정폭), `side` 는 곁가지 질문과 답(첫 줄이 질문, 빈 줄 뒤가 답)이다 */
export type NoticeKind = "interrupted" | "compacted" | "info" | "error" | "denied" | "turnStats" | "ended" | "shell" | "side";

export interface Notice {
  kind: NoticeKind;
  text: string;
}

export interface ConversationStatus {
  sessionID?: string;
  model?: string;
  permissionMode?: string;
  cliVersion?: string;
  cwd?: string;
  slashCommands: string[];
  /** 세션 누적 비용 — result 가 누적값을 준다 */
  totalCostUSD?: number;
  contextTokens?: number;
  isTurnActive: boolean;
  turnStartedAt?: number;
  retryNotice?: string;
  promptSuggestion?: string;
  /** 요금제 한도 경고 — allowed 로 돌아오면 지운다 */
  rateLimit?: { status: string; utilization?: number; resetsAt?: number; rateLimitType?: string };
  exitCode?: number;
  isCompacting: boolean;
  /** /rename·`renameSession` 이 붙인 제목 */
  sessionTitle?: string;
  /** 턴 끝의 요약(`system/post_turn_summary`) — 알림 본문으로 쓴다. 다음 턴이 시작하면 지운다 */
  turnSummary?: string;
  /** 이 턴의 「다음 단계」 상자(`wrap_up`) — 턴 완료 알림의 본문이 된다. 다음 턴이 시작하면 지운다 */
  wrapUp?: TurnWrapUp;
  /** 마지막으로 받은 본 대화 메시지 uuid */
  leafUUID?: string;
  /** 살아 있는 백그라운드 작업(`system/background_tasks_changed`) — 이게 있으면 유휴 세션을 닫지 않는다 */
  backgroundTasks?: BackgroundTask[];
  /** 다음 요청의 노력도 — init 이나 `get_settings` 의 적용값. 노력도를 받지 않는 모델이면 없다 */
  effort?: string;
  fastMode?: FastModeStatus;
  contextWindow?: ContextWindow;
}

export function newConversationModel(): ConversationModel {
  return {
    items: [], pending: [], tasks: [], status: { slashCommands: [], isTurnActive: false, isCompacting: false }, queued: [],
    revision: 0, structure: 0,
    indexByID: new Map(), streamingBlockIDs: new Map(), finalizedBlockCount: new Map(), toolIDByTaskID: new Map(),
    images: new Map(), askedToolIDs: new Set(),
  };
}

/** 리듀서 입력 — SDK 메시지와 데몬 쪽 사건 */
export type ConversationEvent =
  /** `quiet` — 모델 턴 없이 기록에만 붙인 줄(`shouldQuery: false`)마다 CLI 가 내는 빈 init·result. 턴을 열고 닫지 않는다 */
  | { kind: "inbound"; inbound: WireInbound; quiet?: boolean }
  /** 사람이 보낸 턴 — SDK 는 되돌려 주지 않으므로 보내는 순간 화면에 낸다 */
  | { kind: "localUser"; id: string; text: string; images?: (StoredImage & { id: string })[]; documents?: string[] }
  /** 모델 턴 없이 기록에 붙인 사람 줄(`!` 셸) — 재생과 같은 모양으로 그린다 */
  | { kind: "localContext"; text: string }
  /** 데몬이 사람 대신 보낸 「이어 가라」 턴 — 사람 말이 아니라 안내 줄로 그리고 턴을 연다 */
  | { kind: "localAutoContinue"; display: string }
  | { kind: "pending"; pending: PendingInteraction }
  /** 답했거나 CLI 가 거뒀다 */
  | { kind: "resolved"; requestID: string }
  | { kind: "processExited"; code: number; message?: string }
  | { kind: "localNotice"; notice: Notice }
  | { kind: "queue"; message: QueuedMessage }
  | { kind: "unqueue"; id: string }
  /** 기록 파일의 AI 제목은 통신으로 오지 않는다 */
  | { kind: "turnSummary"; text: string }
  /** `get_settings` 의 `applied` — 턴 없이도 답한다. 노력도를 받지 않는 모델이면 `effort` 가 null 이다 */
  | { kind: "appliedSettings"; model?: string; effort: string | null }
  /** `get_context_usage` summary — 지금 쓴 양과 창 크기 */
  | { kind: "contextUsage"; used: number; window: ContextWindow };

const INTERRUPT_MARKER = "[Request interrupted by user";
const NO_RESPONSE_PLACEHOLDER = "No response requested.";

export const ConversationReducer = {
  interruptMarker: INTERRUPT_MARKER,

  /** 모델을 제자리에서 고친다. `at` 은 epoch 밀리초 */
  apply(event: ConversationEvent, model: ConversationModel, at: number = Date.now()): void {
    const firstNew = model.items.length;
    const stamp = event.kind === "inbound" && (event.inbound.kind === "assistant" || event.inbound.kind === "user")
      ? event.inbound.message.timestamp ?? at : at;
    switch (event.kind) {
      case "inbound":
        if (event.quiet === true) applyQuiet(event.inbound, model);
        else applyInbound(event.inbound, model, stamp);
        break;
      case "localUser": {
        const images = (event.images ?? []).map((image) => storeImage(model, image.id, image));
        const split = splitAttachments(event.text);
        const files = [...(event.documents ?? []), ...split.files];
        append({
          id: event.id, content: { kind: "user", text: forkDirectiveDisplay(split.text) ?? split.text },
          ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}),
          ...(split.snippets.length > 0 ? { snippets: split.snippets } : {}),
        }, model);
        startTurn(model, at);
        break;
      }
      case "localContext":
        applyUserText(event.text, model);
        break;
      case "localAutoContinue":
        appendNotice("auto", { kind: "info", text: event.display }, model);
        startTurn(model, at);
        break;
      case "pending": {
        if (model.pending.some((pending) => pending.requestID === event.pending.requestID)) return;
        model.pending = [...model.pending, event.pending];
        const toolID = pendingToolUseID(event.pending);
        if (toolID !== undefined) {
          model.askedToolIDs.add(toolID);
          updateTool(toolID, model, (call) => ({ ...call, state: "awaitingDecision" }));
        }
        break;
      }
      case "resolved": {
        const resolved = model.pending.find((pending) => pending.requestID === event.requestID);
        if (resolved === undefined) return;
        model.pending = model.pending.filter((pending) => pending.requestID !== event.requestID);
        const toolID = pendingToolUseID(resolved);
        if (toolID !== undefined) {
          updateTool(toolID, model, (call) => (call.state === "awaitingDecision" ? { ...call, state: "running" } : call));
        }
        break;
      }
      case "localNotice":
        appendNotice("local", event.notice, model);
        break;
      case "queue":
        model.queued = [...model.queued, event.message];
        break;
      case "unqueue":
        model.queued = model.queued.filter((message) => message.id !== event.id);
        break;
      case "turnSummary":
        model.status.turnSummary = event.text;
        break;
      case "appliedSettings":
        model.status.model = event.model ?? model.status.model;
        model.status.effort = event.effort ?? undefined;
        break;
      case "contextUsage":
        model.status.contextTokens = event.used;
        model.status.contextWindow = event.window;
        break;
      case "processExited":
        model.status.exitCode = event.code;
        model.status.promptSuggestion = undefined;
        model.status.isCompacting = false;
        model.status.isTurnActive = false;
        model.status.turnStartedAt = undefined;
        model.pending = [];
        finishStreaming(model);
        stopDetachedWork(model);
        model.status.backgroundTasks = undefined;
        if (event.code !== 0 || event.message !== undefined) {
          appendNotice("exit", { kind: event.code === 0 ? "ended" : "error", text: event.message ?? `세션 프로세스가 종료 코드 ${event.code}로 끝났습니다.` }, model);
        }
        break;
    }
    for (let index = firstNew; index < model.items.length; index += 1) {
      const item = model.items[index]!;
      if (item.startedAt === undefined) model.items[index] = { ...item, startedAt: stamp };
    }
    model.revision += 1;
  },

  /** 재생의 마무리 — 흘리던 글을 닫고 턴을 내린다 */
  finishReplay(model: ConversationModel): ConversationModel {
    finishStreaming(model);
    model.status.isTurnActive = false;
    model.status.turnStartedAt = undefined;
    return model;
  },

  tagContent,
};

function startTurn(model: ConversationModel, at: number): void {
  model.status.isTurnActive = true;
  model.status.turnStartedAt = at;
  model.status.promptSuggestion = undefined;
  model.status.turnSummary = undefined;
  model.status.wrapUp = undefined;
}

// MARK: - SDK 메시지

/** 모델 턴이 없는 init·result — 세션 정보만 읽는다(실측: `shouldQuery: false` 줄마다 init 과 `num_turns: 0` 인 result 가 온다) */
function applyQuiet(inbound: WireInbound, model: ConversationModel): void {
  if (inbound.kind === "systemInit") {
    model.status.sessionID = inbound.info.sessionID ?? model.status.sessionID;
    model.status.model = inbound.info.model ?? model.status.model;
    if (inbound.info.slashCommands.length > 0) model.status.slashCommands = inbound.info.slashCommands;
  } else if (inbound.kind === "result") {
    if (inbound.result.totalCostUSD !== undefined) model.status.totalCostUSD = inbound.result.totalCostUSD;
    if (inbound.result.sessionID !== undefined) model.status.sessionID = inbound.result.sessionID;
  }
}

function applyInbound(inbound: WireInbound, model: ConversationModel, now: number): void {
  switch (inbound.kind) {
    case "systemInit": {
      const info = inbound.info;
      model.status.sessionID = info.sessionID ?? model.status.sessionID;
      model.status.cwd = info.cwd ?? model.status.cwd;
      model.status.model = info.model ?? model.status.model;
      model.status.permissionMode = info.permissionMode ?? model.status.permissionMode;
      model.status.cliVersion = info.cliVersion ?? model.status.cliVersion;
      if (info.slashCommands.length > 0) model.status.slashCommands = info.slashCommands;
      if (info.fastMode !== undefined) model.status.fastMode = info.fastMode;
      if (info.effort !== undefined) model.status.effort = info.effort ?? undefined;
      // 서브에이전트가 끝나 사람 입력 없이 시작한 턴도 init 으로 시작한다
      if (!model.status.isTurnActive) startTurn(model, now);
      return;
    }
    case "system":
      applySystem(inbound.subtype, inbound.payload, model);
      return;
    case "assistant":
      applyAssistant(inbound.message, model, now);
      return;
    case "user":
      applyUser(inbound.message, model, now);
      return;
    case "streamEvent":
      // 서브에이전트는 부분 메시지를 내지 않는다(실측) — 와도 최종 이벤트로 충분하다
      if (inbound.parentToolUseID !== undefined) return;
      applyStream(inbound.event, model);
      return;
    case "result": {
      const result = inbound.result;
      model.status.isTurnActive = false;
      model.status.turnStartedAt = undefined;
      model.status.retryNotice = undefined;
      // 비용은 누적으로 온다 — 턴 값은 직전 누적과의 차다
      const turnCost = result.totalCostUSD === undefined ? undefined : result.totalCostUSD - (model.status.totalCostUSD ?? 0);
      if (result.totalCostUSD !== undefined) model.status.totalCostUSD = result.totalCostUSD;
      if (result.sessionID !== undefined) model.status.sessionID = result.sessionID;
      if (result.fastMode !== undefined) model.status.fastMode = result.fastMode;
      finishStreaming(model);
      // 중단은 「[Request interrupted by user]」 줄이 이미 알렸다
      if (result.isError && !lastNoticeIsInterrupt(model) && !lastItemIsErrorNotice(model)) {
        const text = result.resultText !== undefined && result.resultText !== "" ? result.resultText : result.subtype;
        appendNotice("result", { kind: "error", text }, model);
      }
      if (!result.isError && (result.numTurns ?? 1) > 0) {
        const text = turnStatsLabel({ durationMS: result.durationMS, outputTokens: result.usage?.outputTokens, costUSD: turnCost });
        if (text !== undefined) appendNotice("turn", { kind: "turnStats", text }, model);
      }
      return;
    }
    case "promptSuggestion": {
      const text = inbound.text.trim();
      if (text !== "" && !model.status.isTurnActive) model.status.promptSuggestion = text;
      return;
    }
    case "rateLimit": {
      const { kind: _kind, ...rateLimit } = inbound;
      model.status.rateLimit = inbound.status === "allowed" ? undefined : rateLimit;
      return;
    }
    case "unknown":
      return;
  }
}

function applySystem(subtype: string, payload: JSONValue, model: ConversationModel): void {
  switch (subtype) {
    case "status": {
      const status = jstr(jget(payload, "status"));
      if (status === "requesting") model.status.isTurnActive = true;
      // 압축은 compacting 으로 시작해 status:null + compact_result 로 끝난다(실측)
      model.status.isCompacting = status === "compacting";
      // 계획 승인 뒤 CLI 가 스스로 모드를 돌린다(실측) — 다음 init 전에 읽는다
      model.status.permissionMode = jstr(jget(payload, "permissionMode")) ?? model.status.permissionMode;
      return;
    }
    case "api_retry": {
      const attempt = jint(jget(payload, "attempt")) ?? 0;
      const max = jint(jget(payload, "max_retries")) ?? 0;
      model.status.retryNotice = `API 재시도 중 (${attempt}/${max})`;
      return;
    }
    case "compact_boundary": {
      model.status.isCompacting = false;
      const before = jint(jget(payload, "compact_metadata", "pre_tokens"));
      const after = jint(jget(payload, "compact_metadata", "post_tokens"));
      const text = before !== undefined && after !== undefined
        ? `대화를 압축했습니다 · ${tokensLabel(before)} → ${tokensLabel(after)} 토큰` : "대화를 압축했습니다.";
      appendNotice("compact", { kind: "compacted", text }, model);
      return;
    }
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification": {
      const taskID = jstr(jget(payload, "task_id"));
      const toolID = jstr(jget(payload, "tool_use_id")) ?? (taskID === undefined ? undefined : model.toolIDByTaskID.get(taskID));
      if (toolID === undefined) return;
      if (taskID !== undefined) model.toolIDByTaskID.set(taskID, toolID);
      updateTool(toolID, model, (call) => {
        const progress: SubagentProgress = { ...(call.subagent ?? {}) };
        const description = jstr(jget(payload, "description"));
        const summary = jstr(jget(payload, "summary"));
        // 진행 줄의 설명은 작업 이름이 아니라 지금 하는 일이다(실측)
        if (subtype === "task_progress") {
          const activity = summary ?? description;
          if (activity !== undefined) progress.activity = activity;
        } else if (description !== undefined) {
          progress.description = description;
        }
        const uses = jint(jget(payload, "usage", "tool_uses"));
        if (uses !== undefined) progress.toolUses = uses;
        const status = jstr(jget(payload, "status")) ?? jstr(jget(payload, "patch", "status"));
        if (status !== undefined) progress.status = status;
        if (summary !== undefined && subtype !== "task_progress") progress.summary = summary;
        const backgrounded = jbool(jget(payload, "is_backgrounded")) ?? jbool(jget(payload, "patch", "is_backgrounded"));
        if (backgrounded !== undefined) progress.isBackgrounded = backgrounded;
        return { ...call, subagent: progress };
      });
      return;
    }
    // 기록에만 남는 줄 — 재개한 화면이 라이브와 같은 구분선을 갖게 한다
    case "turn_duration": {
      const text = turnStatsLabel({ durationMS: jint(jget(payload, "durationMs")) });
      if (text !== undefined) appendNotice("turn", { kind: "turnStats", text }, model);
      return;
    }
    case "local_command": {
      const content = jstr(jget(payload, "content"));
      if (content !== undefined) applyUserText(content, model);
      return;
    }
    case "hook_response": {
      // 훅은 도구마다 뜬다 — 실패만 보인다
      if (jstr(jget(payload, "outcome")) !== "error") return;
      const name = jstr(jget(payload, "hook_name")) ?? "훅";
      const code = jint(jget(payload, "exit_code"));
      const detail = firstLine(jstr(jget(payload, "stderr")) ?? "") ?? firstLine(jstr(jget(payload, "output")) ?? "");
      const head = code === undefined ? `훅 ${name} 실패` : `훅 ${name} 실패 (종료 코드 ${code})`;
      appendNotice("hook", { kind: "error", text: detail === undefined ? head : `${head} · ${detail}` }, model);
      return;
    }
    case "permission_denied": {
      const toolID = jstr(jget(payload, "tool_use_id"));
      if (toolID !== undefined && model.askedToolIDs.has(toolID)) return;
      const tool = jstr(jget(payload, "tool_name")) ?? "도구";
      const reason = firstLine(jstr(jget(payload, "decision_reason")) ?? jstr(jget(payload, "message")) ?? "");
      const head = `${tool} 호출이 자동으로 거부되었습니다`;
      appendNotice("denied", { kind: "denied", text: reason === undefined ? head : `${head} · ${reason}` }, model);
      return;
    }
    case "informational": {
      const level = jstr(jget(payload, "level"));
      const text = (jstr(jget(payload, "content")) ?? "").trim();
      if (text === "" || level === "info") return;
      appendNotice("informational", { kind: level === "warning" ? "error" : "info", text }, model);
      return;
    }
    case "local_command_output": {
      const text = (jstr(jget(payload, "content")) ?? "").trim();
      if (text !== "") appendNotice("local-command", { kind: "info", text }, model);
      return;
    }
    case "session_title_changed": {
      const title = (jstr(jget(payload, "title")) ?? "").trim();
      if (title !== "") model.status.sessionTitle = title;
      return;
    }
    case "post_turn_summary": {
      // 데스크톱 앱이 알림 본문으로 쓰는 것 — 턴이 끝난 뒤 늦게 오고 모든 세션에 오지는 않는다
      const detail = (jstr(jget(payload, "status_detail")) ?? "").trim();
      const needsAction = (jstr(jget(payload, "needs_action")) ?? "").trim();
      const text = [detail, needsAction].filter((part) => part !== "").join(" · ");
      if (text !== "") model.status.turnSummary = text;
      return;
    }
    case "conversation_reset":
      model.items = [];
      model.indexByID = new Map();
      model.tasks = [];
      model.streamingMessageID = undefined;
      model.streamingBlockIDs = new Map();
      model.finalizedBlockCount = new Map();
      model.toolIDByTaskID = new Map();
      model.askedToolIDs = new Set();
      model.status.sessionTitle = undefined;
      model.status.contextTokens = undefined;
      model.structure += 1;
      return;
    case "background_tasks_changed": {
      // 살아 있는 백그라운드 작업의 전체 집합이 통째로 온다(실측). 살림·감시자(ambient)는 활동이 아니다
      model.status.backgroundTasks = (jarr(jget(payload, "tasks")) ?? []).flatMap((task): BackgroundTask[] => {
        const id = jstr(jget(task, "task_id"));
        if (id === undefined || jbool(jget(task, "ambient")) === true) return [];
        const type = jstr(jget(task, "task_type"));
        const description = jstr(jget(task, "description"));
        return [{ id, ...(type !== undefined ? { type } : {}), ...(description !== undefined ? { description } : {}) }];
      });
      return;
    }
    case "tool_progress": {
      const toolID = jstr(jget(payload, "tool_use_id"));
      const attempt = jint(jget(payload, "subagent_retry", "attempt"));
      if (toolID === undefined || attempt === undefined) return;
      const max = jint(jget(payload, "subagent_retry", "max_retries")) ?? 0;
      updateTool(toolID, model, (call) => ({ ...call, subagent: { ...(call.subagent ?? {}), activity: `API 재시도 중 (${attempt}/${max})` } }));
      return;
    }
    default:
      return;
  }
}

function applyAssistant(message: WireMessage, model: ConversationModel, now: number): void {
  if (message.parentToolUseID === undefined && message.uuid !== undefined) model.status.leafUUID = message.uuid;
  model.status.retryNotice = undefined;
  if (message.parentToolUseID === undefined && message.usage !== undefined && usageContextTokens(message.usage) > 0) {
    model.status.contextTokens = usageContextTokens(message.usage);
  }
  if (message.isApiError || message.isSyntheticModel) {
    const text = message.content.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n").trim();
    // 실패한 API 호출은 모델의 답이 아니다 — 오류 구분선으로. 서브에이전트의 것은 그 묶음 안에 둔다
    if (message.isApiError) {
      if (text !== "") appendNotice("api-error", { kind: "error", text }, model, message.parentToolUseID);
      return;
    }
    // 중단 뒤 CLI 가 대화 짝을 맞추려고 넣는 자리표시 — 답이 아니다
    if (text === NO_RESPONSE_PLACEHOLDER) return;
  }
  const messageID = message.messageID ?? `msg-${model.revision}`;
  for (const block of message.content) {
    const ordinal = model.finalizedBlockCount.get(messageID) ?? 0;
    model.finalizedBlockCount.set(messageID, ordinal + 1);
    const blockID = `${messageID}:${ordinal}`;
    const parent = message.parentToolUseID === undefined ? {} : { parentToolUseID: message.parentToolUseID };
    switch (block.kind) {
      case "text":
        upsert({ id: blockID, ...parent, content: { kind: "assistant", text: block.text, isStreaming: false } }, model, now);
        break;
      case "thinking":
        upsert({ id: blockID, ...parent, content: { kind: "thinking", text: block.text, isStreaming: false } }, model, now);
        break;
      case "toolUse": {
        applyTaskInput(block.name, block.input, model);
        if (block.name === WRAP_UP_FULL_NAME && message.parentToolUseID === undefined) model.status.wrapUp = wrapUpContent(block.input);
        const index = model.indexByID.get(block.id);
        const existing = index === undefined ? undefined : model.items[index];
        if (index !== undefined && existing !== undefined && existing.content.kind === "tool") {
          const call = existing.content.call;
          model.items[index] = {
            ...existing,
            content: { kind: "tool", call: { ...call, input: block.input, partialInput: "", state: call.state === "composing" ? "running" : call.state } },
          };
        } else {
          append({ id: block.id, ...parent, content: { kind: "tool", call: newToolCall(block.id, block.name, block.input) } }, model);
        }
        break;
      }
      default:
        break;
    }
  }
}

function applyUser(message: WireMessage, model: ConversationModel, now: number): void {
  if (message.parentToolUseID === undefined && !message.isReplay && message.uuid !== undefined) model.status.leafUUID = message.uuid;
  if (message.isMeta) return;
  // 사람이 아닌 출처의 줄 — 기록은 백그라운드 작업의 완료 통지를 user 줄로 남긴다
  if (message.origin !== undefined && message.origin !== "human") {
    if (message.origin === "task-notification") {
      for (const block of message.content) if (block.kind === "text") applyTaskNotificationText(block.text, model);
    } else if (message.origin === "auto-continuation") {
      for (const block of message.content) {
        if (block.kind === "text") appendNotice("auto", { kind: "info", text: autoContinuationDisplay(block.text) ?? "끊긴 작업을 이어 갑니다." }, model);
      }
    }
    return;
  }
  if (message.isCompactSummary) {
    const last = model.items.at(-1)?.content;
    if (last !== undefined && last.kind === "notice" && last.notice.kind === "compacted") return;
    appendNotice("compact", { kind: "compacted", text: "대화를 압축했습니다." }, model);
    return;
  }
  if (message.isReplay) {
    // 호스트 제어의 결과(`<local-command-stdout>`)도 isReplay 로 온다(실측) — 그것만 살린다
    for (const block of message.content) {
      if (block.kind === "text" && tagContent("local-command-stdout", block.text) !== undefined) applyUserText(block.text, model);
    }
    return;
  }
  // 구조화 메타는 메시지 단위로 온다 — 결과 블록이 하나일 때만 그 도구에 붙인다
  const resultCount = message.content.filter((block) => block.kind === "toolResult").length;
  for (const block of message.content) {
    switch (block.kind) {
      case "toolResult": {
        const meta = resultCount === 1 ? withoutImageBody(message.toolUseResult) : undefined;
        const images = block.images.map((image, index) => storeImage(model, `${block.toolUseID}:image:${index}`, image));
        updateTool(block.toolUseID, model, (call) => ({
          ...call, result: block.content, ...(meta !== undefined ? { resultMeta: meta } : {}),
          state: block.isError ? "failed" : "succeeded", ...(images.length > 0 ? { resultImages: images } : {}),
        }));
        const taskID = jstr(jget(meta, "backgroundTaskId")) ?? jstr(jget(meta, "agentId"));
        if (taskID !== undefined) model.toolIDByTaskID.set(taskID, block.toolUseID);
        const index = model.indexByID.get(block.toolUseID);
        if (index !== undefined) {
          const item = { ...model.items[index]!, finishedAt: now };
          model.items[index] = item;
          if (item.content.kind === "tool" && !block.isError) applyTaskResult(item.content.call.name, item.content.call.input, meta, model);
        }
        break;
      }
      case "text": {
        // 서브에이전트에 건넨 프롬프트는 Agent 카드 입력에 이미 있다
        if (message.parentToolUseID !== undefined) continue;
        const before = model.items.length;
        applyUserText(block.text, model);
        attachImages(model, before, message);
        break;
      }
      default:
        break;
    }
  }
  // 글 없이 이미지·문서만 보낸 턴
  if (message.parentToolUseID === undefined && resultCount === 0 && message.content.some((block) => block.kind === "image" || block.kind === "document")
    && !message.content.some((block) => block.kind === "text" && block.text.trim() !== "")) {
    const before = model.items.length;
    append({ id: `user-${model.revision}-${before}`, content: { kind: "user", text: "" } }, model);
    attachImages(model, before, message);
  }
}

/** 그림 파일을 읽은 결과의 메타는 본문을 base64 로 한 벌 더 든다 — 결과 블록의 이미지로 이미 쥐고 있다 */
function withoutImageBody(meta: JSONValue | undefined): JSONValue | undefined {
  const file = jget(meta, "file");
  if (meta === undefined || meta === null || typeof meta !== "object" || Array.isArray(meta)) return meta;
  if (file === undefined || file === null || typeof file !== "object" || Array.isArray(file) || typeof file.base64 !== "string") return meta;
  const { base64: _body, ...rest } = file;
  return { ...meta, file: rest };
}

/** 사람 턴의 이미지·문서 블록을 그 줄에 붙인다 — 문서는 파일 칩으로(이름만) */
function attachImages(model: ConversationModel, from: number, message: WireMessage): void {
  const item = model.items[from];
  if (item === undefined || item.content.kind !== "user" || item.images !== undefined) return;
  const blocks = message.content.flatMap((block) => (block.kind === "image" ? [block.image] : []));
  const documents = message.content.flatMap((block) => (block.kind === "document" ? [block.title] : []));
  if (blocks.length === 0 && documents.length === 0) return;
  const images = blocks.map((image, index) => storeImage(model, `${item.id}:image:${index}`, image));
  model.items[from] = {
    ...item, ...(images.length > 0 ? { images } : {}), ...(documents.length > 0 ? { files: [...documents, ...(item.files ?? [])] } : {}),
  };
}

function applyUserText(text: string, model: ConversationModel): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  const id = `user-${model.revision}-${model.items.length}`;
  const split = splitAttachments(trimmed);
  if (split.files.length > 0 || split.snippets.length > 0) {
    append({
      id, content: { kind: "user", text: forkDirectiveDisplay(split.text) ?? split.text },
      ...(split.files.length > 0 ? { files: split.files } : {}), ...(split.snippets.length > 0 ? { snippets: split.snippets } : {}),
    }, model);
    return;
  }
  const fork = forkDirectiveDisplay(trimmed);
  if (fork !== undefined) {
    append({ id, content: { kind: "user", text: fork } }, model);
    return;
  }
  // 데몬이 보낸 이어 가기 턴 — 출처 표시가 없는 옛 줄도 문장으로 알아본다
  const continuation = autoContinuationDisplay(trimmed);
  if (continuation !== undefined) {
    appendNotice("auto", { kind: "info", text: continuation }, model);
    return;
  }
  const output = tagContent("local-command-stdout", trimmed);
  const command = tagContent("command-name", trimmed);
  if (trimmed.startsWith(INTERRUPT_MARKER)) {
    appendNotice("interrupt", { kind: "interrupted", text: "턴을 중단했습니다." }, model);
  } else if (output !== undefined) {
    if (output !== "" && !output.startsWith("Compacted")) append({ id, content: { kind: "notice", notice: { kind: "info", text: output } } }, model);
  } else if (command !== undefined) {
    const args = tagContent("command-args", trimmed) ?? "";
    append({ id, content: { kind: "user", text: args === "" ? command : `${command} ${args}` } }, model);
  } else if (trimmed.startsWith("<bash-input>") || trimmed.startsWith("<bash-stdout>")) {
    // `!` 셸 모드 줄 — 명령은 사람 말로, 출력은 고정폭 안내 줄로
    const input = tagContent("bash-input", trimmed);
    if (input !== undefined) {
      append({ id, content: { kind: "user", text: `! ${input}` } }, model);
      return;
    }
    const output = [tagContent("bash-stdout", trimmed), tagContent("bash-stderr", trimmed)].filter((part) => part !== undefined && part !== "").join("\n");
    appendNotice("shell", { kind: "shell", text: output === "" ? "(빈 출력)" : unescapeShellOutput(output) }, model);
  } else if (trimmed.startsWith("<") && trimmed.endsWith(">") && !trimmed.includes("\n\n")) {
    // 그 밖의 태그 한 덩어리(local-command-caveat 등)는 사람 말이 아니다
    return;
  } else {
    append({ id, content: { kind: "user", text: trimmed } }, model);
  }
}

function applyTaskNotificationText(text: string, model: ConversationModel): void {
  const payload: { [key: string]: JSONValue } = {};
  for (const [key, tag] of [["task_id", "task-id"], ["tool_use_id", "tool-use-id"], ["status", "status"], ["summary", "summary"]] as const) {
    const value = tagContent(tag, text);
    if (value !== undefined) payload[key] = value;
  }
  applySystem("task_notification", payload, model);
}

/** 셸 출력은 터미널처럼 HTML 이스케이프해 기록에 붙는다 — 화면에는 원래 글자로 */
function unescapeShellOutput(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function tagContent(tag: string, text: string): string | undefined {
  const openTag = `<${tag}>`;
  const open = text.indexOf(openTag);
  if (open === -1) return undefined;
  const start = open + openTag.length;
  const close = text.indexOf(`</${tag}>`, start);
  if (close === -1) return undefined;
  return text.slice(start, close).trim();
}

// MARK: - 스트리밍

function applyStream(event: WireStreamEvent, model: ConversationModel): void {
  switch (event.kind) {
    case "messageStart":
      model.streamingMessageID = event.messageID;
      model.streamingBlockIDs = new Map();
      return;
    case "blockStart": {
      const messageID = model.streamingMessageID ?? `stream-${model.revision}`;
      const block = event.block;
      if (block.kind === "toolUse") {
        model.streamingBlockIDs.set(event.index, block.id);
        if (!model.indexByID.has(block.id)) {
          append({ id: block.id, content: { kind: "tool", call: { ...newToolCall(block.id, block.name, {}), state: "composing" } } }, model);
        }
        return;
      }
      if (block.kind !== "text" && block.kind !== "thinking") return;
      const id = `${messageID}:${event.index}`;
      model.streamingBlockIDs.set(event.index, id);
      if (!model.indexByID.has(id)) {
        append({
          id, content: block.kind === "text"
            ? { kind: "assistant", text: block.text, isStreaming: true } : { kind: "thinking", text: "", isStreaming: true },
        }, model);
      }
      return;
    }
    case "textDelta":
    case "thinkingDelta": {
      const kind = event.kind === "textDelta" ? "assistant" : "thinking";
      const id = model.streamingBlockIDs.get(event.index);
      const at = id === undefined ? undefined : model.indexByID.get(id);
      const item = at === undefined ? undefined : model.items[at];
      const content = item?.content;
      if (at === undefined || item === undefined || content === undefined || content.kind !== kind || !content.isStreaming) return;
      model.items[at] = { ...item, content: { kind, text: content.text + event.text, isStreaming: true } };
      return;
    }
    case "inputJSONDelta": {
      const id = model.streamingBlockIDs.get(event.index);
      if (id === undefined) return;
      updateTool(id, model, (call) => (call.state === "composing" ? { ...call, partialInput: call.partialInput + event.partialJSON } : call));
      return;
    }
    case "other":
      return;
  }
}

/** 턴이 끝났는데 최종 블록이 오지 않은 스트리밍 항목(중단 등)을 굳힌다 */
function finishStreaming(model: ConversationModel): void {
  for (let index = 0; index < model.items.length; index += 1) {
    const item = model.items[index]!;
    const content = item.content;
    if ((content.kind === "assistant" || content.kind === "thinking") && content.isStreaming) {
      model.items[index] = { ...item, content: { ...content, isStreaming: false } };
    } else if (content.kind === "tool" && content.call.state === "composing") {
      model.items[index] = { ...item, content: { kind: "tool", call: { ...content.call, state: "failed" } } };
    }
  }
  model.streamingMessageID = undefined;
  model.streamingBlockIDs = new Map();
}

/** 프로세스가 나가면 따로 돌던 작업도 같이 끝난다 — 값은 CLI 가 재개 때 알리는 것과 같은 `stopped` */
function stopDetachedWork(model: ConversationModel): void {
  for (let index = 0; index < model.items.length; index += 1) {
    const item = model.items[index]!;
    if (item.content.kind !== "tool") continue;
    const call = item.content.call;
    const progress = call.subagent;
    const unfinished = call.state === "running" || call.state === "awaitingDecision";
    if (progress !== undefined && !subagentIsFinished(progress)) {
      model.items[index] = { ...item, content: { kind: "tool", call: { ...call, subagent: { ...progress, status: "stopped" }, ...(unfinished ? { state: "failed" } : {}) } } };
    } else if (unfinished) {
      model.items[index] = { ...item, content: { kind: "tool", call: { ...call, state: "failed" } } };
    }
  }
}

function subagentIsFinished(progress: SubagentProgress): boolean {
  return progress.status === "completed" || progress.status === "failed" || progress.status === "killed" || progress.status === "stopped";
}

// MARK: - 할 일

function taskStatus(raw: string | undefined): TaskEntry["status"] | undefined {
  return raw === "pending" || raw === "in_progress" || raw === "completed" ? raw : undefined;
}

/** TodoWrite 는 입력이 곧 전체 목록이다 — 도구 호출 시점에 갈아 끼운다. 턴 도구는 호출마다 목록을 고친다(`turn-box.ts`) */
function applyTaskInput(name: string, input: JSONValue, model: ConversationModel): void {
  if (name === UPDATE_PLAN_FULL_NAME || name === WRAP_UP_FULL_NAME) {
    const tasks = [...model.tasks];
    if (name === UPDATE_PLAN_FULL_NAME) applyPlanUpdate(tasks, input);
    else completePlan(tasks);
    model.tasks = tasks;
    return;
  }
  const todos = jarr(jget(input, "todos"));
  if (name !== "TodoWrite" || todos === undefined) return;
  model.tasks = todos.map((todo, index): TaskEntry => {
    const activeForm = jstr(jget(todo, "activeForm"));
    return {
      id: jstr(jget(todo, "id")) ?? `todo-${index}`, subject: jstr(jget(todo, "content")) ?? "",
      status: taskStatus(jstr(jget(todo, "status"))) ?? "pending", ...(activeForm !== undefined ? { activeForm } : {}),
    };
  });
}

/** TaskCreate 는 결과 메타가 id 를 주고 TaskUpdate 는 입력이 id·상태를 준다(실측) */
function applyTaskResult(name: string, input: JSONValue, meta: JSONValue | undefined, model: ConversationModel): void {
  if (name === "TaskCreate") {
    const id = jstr(jget(meta, "task", "id"));
    if (id === undefined) return;
    const subject = jstr(jget(meta, "task", "subject")) ?? jstr(jget(input, "subject")) ?? "";
    const activeForm = jstr(jget(input, "activeForm"));
    model.tasks = model.tasks.some((task) => task.id === id)
      ? model.tasks.map((task) => (task.id === id ? { ...task, subject } : task))
      : [...model.tasks, { id, subject, status: "pending", ...(activeForm !== undefined ? { activeForm } : {}) }];
    return;
  }
  if (name !== "TaskUpdate") return;
  const id = jstr(jget(input, "taskId")) ?? jstr(jget(meta, "taskId"));
  if (id === undefined) return;
  const raw = jstr(jget(input, "status")) ?? jstr(jget(meta, "statusChange", "to"));
  if (raw === "deleted") {
    model.tasks = model.tasks.filter((task) => task.id !== id);
    return;
  }
  const status = taskStatus(raw);
  const subject = jstr(jget(input, "subject"));
  model.tasks = model.tasks.map((task) => (task.id !== id ? task : {
    ...task, ...(status !== undefined ? { status } : {}), ...(subject !== undefined ? { subject } : {}),
  }));
}

// MARK: - 배열 조작

function newToolCall(toolUseID: string, name: string, input: JSONValue): ToolCall {
  return { toolUseID, name, input, partialInput: "", state: "running" };
}

function append(item: ConversationItem, model: ConversationModel): void {
  model.indexByID.set(item.id, model.items.length);
  model.items.push(item);
}

function appendNotice(prefix: string, notice: Notice, model: ConversationModel, parentToolUseID?: string): void {
  append({
    id: `${prefix}-${model.revision}-${model.items.length}`, content: { kind: "notice", notice },
    ...(parentToolUseID !== undefined ? { parentToolUseID } : {}),
  }, model);
}

/** 스트리밍 항목을 최종 블록으로 덮을 때 처음 나타난 시각은 지킨다 */
function upsert(item: ConversationItem, model: ConversationModel, finishedAt: number): void {
  const index = model.indexByID.get(item.id);
  if (index !== undefined) model.items[index] = { ...item, finishedAt, startedAt: model.items[index]?.startedAt };
  else append({ ...item, finishedAt }, model);
}

function updateTool(id: string, model: ConversationModel, change: (call: ToolCall) => ToolCall): void {
  const index = model.indexByID.get(id);
  const item = index === undefined ? undefined : model.items[index];
  if (index === undefined || item === undefined || item.content.kind !== "tool") return;
  model.items[index] = { ...item, content: { kind: "tool", call: change(item.content.call) } };
}

/** 세션 하나가 쥐는 이미지 본문의 상한(base64 글자 수) — 넘으면 오래된 것부터 버린다 */
const IMAGE_BUDGET = 64 * 1024 * 1024;

function storeImage(model: ConversationModel, id: string, image: StoredImage): ImageRef {
  model.images.set(id, { mediaType: image.mediaType, data: image.data });
  let total = 0;
  for (const stored of model.images.values()) total += stored.data.length;
  for (const key of model.images.keys()) {
    if (total <= IMAGE_BUDGET || key === id) break;
    total -= model.images.get(key)!.data.length;
    model.images.delete(key);
  }
  return { id, mediaType: image.mediaType };
}

function lastItemIsErrorNotice(model: ConversationModel): boolean {
  const content = model.items.at(-1)?.content;
  return content !== undefined && content.kind === "notice" && content.notice.kind === "error";
}

function lastNoticeIsInterrupt(model: ConversationModel): boolean {
  for (let index = model.items.length - 1; index >= 0; index -= 1) {
    const content = model.items[index]!.content;
    if (content.kind === "notice") return content.notice.kind === "interrupted";
    if (content.kind === "user") return false;
  }
  return false;
}

function firstLine(text: string): string | undefined {
  const line = (text.split("\n").find((part) => part.trim() !== "") ?? "").trim();
  if (line === "") return undefined;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function tokensLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** 턴 끝의 한 줄 — 「12초 · 1.2k 토큰 · $0.03」 */
function turnStatsLabel(input: { durationMS?: number; outputTokens?: number; costUSD?: number }): string | undefined {
  const parts: string[] = [];
  if (input.durationMS !== undefined) {
    const seconds = Math.round(input.durationMS / 1000);
    parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`);
  }
  if (input.outputTokens !== undefined && input.outputTokens > 0) parts.push(`${tokensLabel(input.outputTokens)} 토큰`);
  if (input.costUSD !== undefined && input.costUSD > 0) parts.push(`$${input.costUSD.toFixed(input.costUSD < 0.1 ? 3 : 2)}`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** 마지막 답의 첫 줄 — 목록의 한 줄과 턴 완료 알림의 대안 본문 */
export function lastMessageLine(model: ConversationModel): string | undefined {
  for (let index = model.items.length - 1; index >= 0; index -= 1) {
    const item = model.items[index]!;
    if (item.parentToolUseID !== undefined) continue;
    const content = item.content;
    if (content.kind === "assistant" || content.kind === "user") {
      const line = firstLine(content.text);
      if (line !== undefined) return content.kind === "user" ? `나: ${line}` : line;
    }
  }
  return undefined;
}

/** 첫 사람 프롬프트 — 제목이 없을 때 */
export function firstPromptLine(model: ConversationModel): string | undefined {
  for (const item of model.items) {
    if (item.content.kind === "user") {
      const line = firstLine(item.content.text);
      if (line !== undefined) return line;
    }
  }
  return undefined;
}
