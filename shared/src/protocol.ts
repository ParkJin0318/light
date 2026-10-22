/**
 * 데몬 ↔ PWA 프로토콜. 기기 → 데몬 메시지는 zod 로 검증하고 데몬 → 기기 메시지는 타입만 맞춘다.
 *
 * 동기화: 데몬이 정본이다. 세션마다 리듀서를 돌리고 바뀐 항목을 순번 붙은 패치로 보낸다.
 * 기기는 `subscribe{sessionId, epoch, lastSeq}` 로 마지막 순번 다음부터 받는다. 데몬이 그 순번을 더 쥐고 있지 않거나
 * `epoch`(데몬 기동·세션 적재마다 바뀐다)가 다르면 끝 부분 스냅샷을 준다. 앞부분은 `GET /api/sessions/:id/events?before=` 로 나눠 받는다
 */
import { z } from "zod";
import type { AttachedSnippet } from "./session/attachments.ts";
import type { TurnWrapUp } from "./session/turn-box.ts";
import type { BackgroundTask, ContextWindow, FastModeStatus, ImageRef, Notice, QueuedMessage, SubagentProgress, TaskEntry, ToolCallState } from "./session/conversation.ts";
import type { PendingInteraction } from "./session/pending.ts";

/** 목록의 상태 — 실행 중·승인 대기·질문 대기·유휴·닫힘·오류 */
export const SESSION_LIFECYCLES = ["starting", "running", "waitingPermission", "waitingQuestion", "idle", "closed", "error"] as const;
export type SessionLifecycle = (typeof SESSION_LIFECYCLES)[number];

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 노력도 — SDK `EffortLevel`. `max` 는 세션 한정이고 지원하지 않는 모델에서는 `high` 로 돈다(d.ts `applyFlagSettings`) */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 고를 수 있는 모델 하나 — claude 가 알려 준 목록(`initializationResult().models`) */
export interface ModelOption {
  /** set_model 에 넘기는 값 — 별칭(sonnet)이거나 판을 박은 id */
  value: string;
  /** 그 값이 실제로 가리키는 모델 id(sonnet → claude-sonnet-5-5) — 세션의 모델과 견준다 */
  resolvedModel?: string;
  label: string;
  description?: string;
  /** 고를 수 있는 노력도 — 없으면 노력도를 받지 않는 모델이다(Haiku 4.5, 2026-10-22 CLI 2.1.308 목록) */
  efforts?: EffortLevel[];
  fastMode?: boolean;
}

/** 세션 목록 한 줄 */
export interface SessionSummary {
  id: string;
  /** 여러 Mac 을 위한 자리 — 지금은 늘 이 데몬 하나다 */
  hostId: string;
  cwd: string;
  project: string;
  title: string;
  /** light 가 띄운 세션인가, Mac 기록에서 온 세션인가 */
  origin: "light" | "history";
  lifecycle: SessionLifecycle;
  /** 답을 기다리는 요청 수 */
  pendingCount: number;
  lastMessage?: string;
  /** epoch 밀리초 */
  updatedAt: number;
  /** Mac 터미널(또는 다른 앱)에서 지금 열려 있다 */
  liveElsewhere?: { busy: boolean };
  model?: string;
  permissionMode?: string;
  archived?: boolean;
}

export interface ViewTool {
  toolUseID: string;
  name: string;
  title: string;
  line: string;
  state: ToolCallState;
  /** 입력 원문(JSON, 줄 바꿈 포함) — 길면 자른다 */
  input: string;
  result?: string;
  truncated?: boolean;
  subagent?: SubagentProgress;
  resultImages?: ImageRef[];
  /** 턴 도구 `wrap_up` 의 「다음 단계」 상자 — 화면은 도구 줄 대신 상자로 그린다 */
  wrapUp?: TurnWrapUp;
}

/** 화면 항목 하나 — 데몬이 리듀서 항목을 줄여 보낸다 */
export interface ViewItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "notice";
  parentToolUseID?: string;
  startedAt?: number;
  finishedAt?: number;
  text?: string;
  isStreaming?: boolean;
  images?: ImageRef[];
  files?: string[];
  snippets?: AttachedSnippet[];
  tool?: ViewTool;
  notice?: Notice;
}

/** 세션 화면의 항목 밖 상태 — 작아서 패치마다 통째로 싣는다 */
export interface SessionView {
  sessionId: string;
  lifecycle: SessionLifecycle;
  origin: "light" | "history";
  title: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  /** 다음 요청에 실을 노력도 — claude 가 알린 적용값, 모르면 고른 값. 없으면 모델 기본값이거나 노력도를 받지 않는 모델이다 */
  effort?: EffortLevel;
  /** 빠른 모드 — 켜 달라고 했는가(`requested`)와 claude 가 init·result 로 알린 상태 */
  fastMode: { requested: boolean } & Partial<FastModeStatus>;
  isTurnActive: boolean;
  turnStartedAt?: number;
  isCompacting: boolean;
  retryNotice?: string;
  promptSuggestion?: string;
  totalCostUSD?: number;
  contextTokens?: number;
  contextWindow?: ContextWindow;
  rateLimit?: { status: string; utilization?: number; resetsAt?: number; rateLimitType?: string };
  pending: PendingInteraction[];
  tasks: TaskEntry[];
  /** 살아 있는 백그라운드 작업 — 하나씩 멈춘다(`stopTask`) */
  backgroundTasks: BackgroundTask[];
  queued: QueuedMessage[];
  liveElsewhere?: { busy: boolean };
  slashCommands: string[];
  error?: string;
}

export type ServerMessage =
  | { type: "welcome"; hostId: string; version: string }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "snapshot"; sessionId: string; epoch: string; seq: number; firstIndex: number; total: number; items: ViewItem[]; view: SessionView }
  | { type: "patch"; sessionId: string; epoch: string; seq: number; upserts: { index: number; item: ViewItem }[]; total: number; view?: SessionView }
  | { type: "sendResult"; clientMessageId: string; ok: boolean; error?: string; queued?: boolean }
  | { type: "respondResult"; requestId: string; ok: boolean; alreadyHandled?: boolean; error?: string }
  | { type: "error"; message: string }
  | { type: "pong" };

/** 맥락으로 붙이는 인용(대화의 답 일부) */
export const snippetSchema = z.object({ label: z.string().max(200).optional(), text: z.string().min(1).max(20_000) });

const answerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow") }),
  z.object({ kind: z.literal("allowSession") }),
  z.object({ kind: z.literal("deny"), reason: z.string().max(20_000).optional() }),
  z.object({ kind: z.literal("answer"), answers: z.record(z.string(), z.string().max(20_000)) }),
  z.object({ kind: z.literal("dismiss"), reply: z.string().max(20_000).optional() }),
  z.object({ kind: z.literal("approvePlan"), acceptEdits: z.boolean().optional() }),
  z.object({ kind: z.literal("rejectPlan"), feedback: z.string().max(20_000).optional() }),
  z.object({
    kind: z.literal("elicitation"), action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({ kind: z.literal("dialog"), choice: z.string().optional() }),
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), sessionId: z.string(), epoch: z.string().optional(), lastSeq: z.number().int().optional() }),
  z.object({ type: z.literal("unsubscribe"), sessionId: z.string() }),
  z.object({
    type: z.literal("send"), sessionId: z.string(), clientMessageId: z.string().max(100), text: z.string().max(200_000),
    attachments: z.array(z.string()).max(40).default([]),
    snippets: z.array(snippetSchema).max(10).default([]),
    /** 턴이 도는 중이면 쌓을지(기본) 지금 끼워 넣을지 */
    mode: z.enum(["queue", "now"]).default("queue"),
  }),
  z.object({ type: z.literal("interrupt"), sessionId: z.string() }),
  /** 도는 포그라운드 도구를 백그라운드로 넘긴다(터미널의 Ctrl+B) */
  z.object({ type: z.literal("background"), sessionId: z.string() }),
  z.object({ type: z.literal("respond"), sessionId: z.string(), requestId: z.string(), answer: answerSchema }),
  z.object({ type: z.literal("setMode"), sessionId: z.string(), mode: z.enum(PERMISSION_MODES) }),
  z.object({ type: z.literal("setModel"), sessionId: z.string(), model: z.string().max(100) }),
  /** `null` 은 모델 기본값으로 돌린다 */
  z.object({ type: z.literal("setEffort"), sessionId: z.string(), effort: z.enum(EFFORT_LEVELS).nullable() }),
  z.object({ type: z.literal("setFastMode"), sessionId: z.string(), on: z.boolean() }),
  /** 백그라운드 작업 하나를 멈춘다 — 중단(interrupt)은 턴만 끊고 작업은 살린다 */
  z.object({ type: z.literal("stopTask"), sessionId: z.string(), taskId: z.string().max(200) }),
  z.object({ type: z.literal("queueCancel"), sessionId: z.string(), queueId: z.string() }),
  z.object({ type: z.literal("queueSendNow"), sessionId: z.string(), queueId: z.string() }),
  /** 보고 있는 세션 — 45초 임차, 기기가 보는 동안 주기적으로 갱신한다 */
  z.object({ type: z.literal("viewing"), sessionId: z.string().nullable() }),
  z.object({ type: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientAnswer = z.infer<typeof answerSchema>;

export const newSessionSchema = z.object({
  cwd: z.string(),
  prompt: z.string().max(200_000),
  attachments: z.array(z.string()).max(40).default([]),
  model: z.string().max(100).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

export const resumeSchema = z.object({
  /** 터미널에서 살아 있으면: 사본으로 이어 가기(기본) 또는 가져오기 */
  mode: z.enum(["resume", "fork", "takeover"]).default("resume"),
  /** 가져오기 대상이 턴을 도는 중일 때 확인을 거쳤다 */
  confirmBusy: z.boolean().optional(),
});

/** 되감기 — 그 사람 메시지 앞으로 코드·대화·둘 다를 돌린다. `dryRun` 이면 바뀔 파일만 센다 */
export const REWIND_SCOPES = ["both", "conversation", "code"] as const;
export type RewindScope = (typeof REWIND_SCOPES)[number];

export const rewindSchema = z.object({
  pointId: z.string().max(100),
  scope: z.enum(REWIND_SCOPES),
  dryRun: z.boolean().optional(),
});

/** 되감을 수 있는 자리 — 기록의 사람 메시지 하나 */
export interface RewindPoint {
  /** 그 사람 메시지의 uuid — 코드 되감기의 열쇠 */
  id: string;
  /** 사람이 보낸 글 — 되감은 뒤 입력창에 돌려 둔다 */
  text: string;
  timestamp?: number;
  /** 그 앞 assistant 메시지의 uuid — 대화 되감기는 여기까지 이어 연다. 첫 메시지면 없다 */
  resumeAt?: string;
}

/** 코드 되감기의 미리보기·결과(SDK `RewindFilesResult`) */
export interface RewindPreview {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/** 백그라운드 작업의 출력(`getTaskOutput`) */
export interface TaskOutput {
  output: string;
  truncated: boolean;
  totalBytes?: number;
}

export const pushSubscriptionSchema = z.object({
  deviceId: z.string().min(8).max(100),
  label: z.string().max(200).optional(),
  subscription: z.object({
    endpoint: z.url(),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
});

export const sessionPatchSchema = z.object({
  title: z.string().max(200).optional(),
  archived: z.boolean().optional(),
});

export interface ProjectCandidate {
  path: string;
  name: string;
  /** 설정에 등록한 폴더인가, 기록에 나온 폴더인가 */
  source: "settings" | "history";
  lastUsedAt?: number;
  /** 그 폴더에서 마지막으로 고른 권한 모드 */
  lastPermissionMode?: PermissionMode;
}

export interface UploadInfo {
  id: string;
  kind: "image" | "file";
  name: string;
  size: number;
  mediaType: string;
}

/** 첨부 상한 */
export const ATTACHMENT_LIMITS = {
  imagesPerMessage: 20,
  imageLongSide: 2000,
  /** 줄인 뒤의 이미지 하나 — API 의 이미지 상한(5MB) 안 */
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  filesPerMessage: 20,
  /**
   * 이만큼 작은 PDF 는 user 메시지의 document 블록으로 실어 모델이 바로 읽는다(2026-10-22 실측). 더 크거나 쪽수를 모르면
   * 다른 파일처럼 `@"경로"` 로 붙인다 — 문서 블록은 매 턴 맥락에 남고 API 는 100쪽을 넘는 문서를 받지 않는다
   */
  documentBytes: 5 * 1024 * 1024,
  documentPages: 20,
} as const;

/** 보고 있는 세션 임차 */
export const VIEWING_LEASE_MS = 45_000;
