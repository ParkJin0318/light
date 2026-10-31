/**
 * 세션 하나 — `query()` 하나를 streaming input 으로 연다. 데몬의 입력 큐를 AsyncIterable 로 넘기고 사람 메시지는 그 큐에 넣는다.
 * SDK 메시지와 데몬 쪽 사건(보낸 말·대기 요청·답·종료)을 같은 리듀서로 먹이고 바뀐 항목은 `SessionChannel` 이 기기로 보낸다.
 *
 * 권한 중계: 권한 요청·AskUserQuestion·ExitPlanMode 는 모두 `canUseTool` 로 온다. 요청을 requestId 로 쥐고 기기에 보이고
 * 답이 올 때까지 콜백을 붙잡는다 — 기한은 없다. 답은 requestId 마다 한 번만 받는다(test-and-set).
 * CLI 가 요청을 거두면(signal) 카드를 닫는다. 프로세스가 나가면 기다리던 콜백은 안전한 쪽(거부)으로 푼다.
 *
 * 닫는 순서: interrupt → 입력 닫기 → 유예 → SIGTERM → SIGKILL. 프로세스는 `spawnClaudeCodeProcess` 로 직접 띄워 쥔다.
 *
 * 폰 명령(`shared/src/session/commands.ts`): `/btw` 곁가지 질문, `/fork`·`/subtask` fork 에이전트, `/background` 백그라운드로 넘기기,
 * `!` 셸 줄. 되감기는 코드(파일 체크포인트)는 떠 있는 프로세스로 돌리고, 대화는 프로세스를 닫은 뒤 그 메시지 앞까지만 이어 연다
 */
import type {
  CanUseTool, ElicitationResult, ModelInfo, OnElicitation, OnUserDialog, Options, PermissionResult, Query, SDKUserMessage,
  SpawnedProcess, SpawnOptions, UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  EFFORT_LEVELS, type ClientAnswer, type EffortLevel, type PermissionMode, type RewindPoint, type RewindPreview, type RewindScope, type SessionLifecycle,
  type SessionSummary, type SessionView, type TaskOutput,
} from "../../../shared/src/protocol.ts";
import type { LightSettings } from "../../../shared/src/settings.ts";
import { composeAttachments, type AttachedSnippet } from "../../../shared/src/session/attachments.ts";
import { SLEEP_CONTINUATION } from "../../../shared/src/session/auto-continuation.ts";
import { forkDirectivePrompt, parseNativeCommand } from "../../../shared/src/session/commands.ts";
import {
  ConversationReducer, lastMessageLine, firstPromptLine, newConversationModel, type ConversationEvent, type ConversationModel, type QueuedMessage,
} from "../../../shared/src/session/conversation.ts";
import { jget, jnum, jstr, type JSONObject, type JSONValue } from "../../../shared/src/session/json-value.ts";
import {
  NO_ANSWER, decisionFor, isPermissionPending, newDialogPending, newElicitationPending, newPermissionPending,
  type PendingInteraction, type PermissionDecision,
} from "../../../shared/src/session/pending.ts";
import { clipPending, fastModeBlockedText, lifecycleOf } from "../../../shared/src/session/view.ts";
import { decodeInbound } from "../../../shared/src/session/wire.ts";
import { projectName, type ClaudeHistory } from "../claude/history.ts";
import { asSpawned, spawnClaude } from "../claude/spawn.ts";
import { errorText, log } from "../log.ts";
import type { Uploads } from "../uploads.ts";
import { SessionChannel } from "./channel.ts";
import { launchOptions, settingsPlan } from "./options.ts";
import { claimOptions, type TakenSpare } from "./spare.ts";
import { pendingProjectMcpServers, terminalBashTimeouts, thinkingDisplay } from "./terminal-parity.ts";

export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export type AttentionEvent =
  | { kind: "pending"; pending: PendingInteraction }
  | { kind: "turnDone" }
  | { kind: "error"; message: string };

export interface LiveSessionHost {
  settings(): LightSettings;
  /** 세션 env — 로그인 셸 env 에 터미널 맞추기 env 를 얹은 것 */
  environment(): Promise<Record<string, string>>;
  claudeExecutable(): Promise<string | undefined>;
  uploads: Uploads;
  history: ClaudeHistory;
  query: QueryFunction;
  hostId: string;
  /** 목록 한 줄이 바뀌었을 수 있다 */
  changed(session: LiveSession): void;
  attention(session: LiveSession, event: AttentionEvent): void;
  /** 다른 곳(터미널)에서 이 세션이 살아 있는가 — 이 데몬의 프로세스는 빼고. `fresh` 면 주기를 기다리지 않고 레지스트리를 다시 읽는다 */
  liveElsewhere(sessionId: string, fresh?: boolean): { busy: boolean } | undefined;
  /** 폴더별 마지막 권한 모드를 기억한다 */
  rememberMode(cwd: string, mode: PermissionMode): void;
  /** claude 가 알려 준 모델 목록 — 새 세션 화면의 선택지로 쓴다 */
  modelsSeen(models: ModelInfo[]): void;
  /** 사람이 보낸 글을 터미널의 입력 이력에 남긴다(설정이 끄면 아무것도 하지 않는다) */
  recordPrompt(session: LiveSession, display: string): void;
  /** 세션 폴더를 동기로 읽어도 되는지 본다 — 허용 창에 붙잡혔거나 막혔으면 할 일을 담아 던진다(`folder-access.ts`) */
  ensureFolder(folder: string): Promise<void>;
}

export class SessionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** 사람 턴을 밀어 넣는 줄 — `end()` 가 stdin EOF 다 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private ended = false;
  /** 내준 것 — 예비 claim 이 거절되면 되감는다 */
  private handedOut: SDKUserMessage[] = [];
  /** 되감아 넘긴 새 줄 — 그 뒤에 이 줄에 넣은 것도 그리로 간다 */
  private forward: InputQueue | undefined;

  /** 내준 것부터 다시 내주는 새 줄 — 이 줄은 닫는다 */
  rewind(): InputQueue {
    const fresh = new InputQueue();
    fresh.items = [...this.handedOut, ...this.items];
    fresh.ended = this.ended;
    this.items = [];
    this.forward = fresh;
    this.end();
    return fresh;
  }

  push(message: SDKUserMessage): void {
    if (this.forward !== undefined) {
      this.forward.push(message);
      return;
    }
    if (this.ended) return;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: false, value: message });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          this.handedOut.push(item);
          return Promise.resolve({ done: false, value: item });
        }
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = (result) => {
            if (result.done !== true) this.handedOut.push(result.value);
            resolve(result);
          };
        });
      },
    };
  }
}

type ProcessState = "closed" | "starting" | "alive" | "closing";

type Waiter = (answer: PermissionDecision | ElicitationResult | UserDialogResult | undefined) => void;

const STOP_WAIT_MS = 4_000;
const TERM_WAIT_MS = 3_000;
/** `!` 셸 줄의 시한과 기록에 붙일 출력의 끝 부분 */
const SHELL_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_TAIL = 30_000;
/** 곁가지 질문의 시한 — 넘으면 오류 줄 */
const SIDE_QUESTION_TIMEOUT_MS = 90_000;

export interface LiveSessionInit {
  id: string;
  cwd: string;
  origin: "light" | "history";
  title?: string;
  autoTitle?: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  fastMode?: boolean;
  lastMessage?: string;
  updatedAt?: number;
  archived?: boolean;
  /** 새로 만든 세션 — 기록이 아직 없다 */
  fresh?: boolean;
  /** 예열한 예비 프로세스 — 첫 기동에 claim 한다 */
  spare?: TakenSpare;
}

export class LiveSession {
  readonly id: string;
  readonly cwd: string;
  origin: "light" | "history";
  customTitle?: string;
  archived: boolean;
  model: ConversationModel = newConversationModel();
  readonly channel: SessionChannel;
  lastActivity: number;
  /** 마지막으로 누가 이 세션을 찾은 때 — 기록 세션을 버릴지 가른다(lastActivity 는 기록 파일 시각이라 오래됐다) */
  touchedAt = Date.now();
  private loaded: boolean;
  private loading: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private process: ProcessState = "closed";
  private failed = false;
  private failure: string | undefined;
  private query: Query | undefined;
  private input: InputQueue | undefined;
  private child: ChildProcess | undefined;
  private generation = 0;
  private stderrTail = "";
  private exited: Promise<void> = Promise.resolve();
  private markExited: () => void = () => {};
  private closing = false;
  private interruptRequested = false;
  private readonly waiters = new Map<string, Waiter>();
  private permissionCounter = 0;
  /** 다음 기동에 쓸 모델·권한 모드 — 떠 있는 동안은 CLI 가 알린 값이 정본이다 */
  private modelChoice: string | undefined;
  private modeChoice: PermissionMode | undefined;
  /** 다음 기동에 쓸 노력도·빠른 모드 — 세션 플래그 층에 싣는다(options.ts `flagSettings`) */
  private effortChoice: EffortLevel | undefined;
  private fastModeChoice: boolean;
  private persistedLastMessage: string | undefined;
  private spare: TakenSpare | undefined;
  /** 첫 메시지로 제목을 지을 세션 — 새로 만든 light 세션만. 지을 글을 받으면 claim 이 확정된 뒤 부탁한다 */
  private wantsTitle: boolean;
  private titleText: string | undefined;
  /** 앞서 물은 곁가지 질문과 답 — 이어 묻게 함께 보낸다 */
  private readonly sideQuestions: { question: string; response: string }[] = [];
  /** 기록에만 붙이고(`shouldQuery: false`) 아직 빈 result 가 오지 않은 줄 수 */
  private silentPending = 0;
  /** 대화를 되감은 자리 — 다음 기동이 이 메시지까지만 이어 연다. 그 뒤 턴이 끝나면 새 갈래가 끝 잎이 되어 지운다 */
  private resumeAt: string | undefined;
  /** 예비 claim 이 확정되기 전에 온 메시지 — 확정되면 흘리고 거절되면 버린다 */
  private held: JSONValue[] | undefined;
  private historyTitle: string | undefined;

  constructor(private readonly host: LiveSessionHost, init: LiveSessionInit) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.origin = init.origin;
    this.customTitle = init.title;
    this.archived = init.archived ?? false;
    this.modelChoice = init.model;
    this.modeChoice = init.permissionMode;
    this.effortChoice = init.effort;
    this.fastModeChoice = init.fastMode === true;
    this.persistedLastMessage = init.lastMessage;
    this.historyTitle = init.autoTitle;
    this.lastActivity = init.updatedAt ?? Date.now();
    this.loaded = init.fresh === true;
    this.wantsTitle = init.fresh === true && init.origin === "light";
    this.spare = init.spare;
    this.model.status.cwd = init.cwd;
    if (init.permissionMode !== undefined) this.model.status.permissionMode = init.permissionMode;
    if (init.model !== undefined) this.model.status.model = init.model;
    if (init.effort !== undefined) this.model.status.effort = init.effort;
    this.channel = new SessionChannel(this.id, () => ({ model: this.model, view: this.view(), cwd: this.cwd }));
  }

  /** 기록을 읽는 중이다 — 유휴 정리가 이 세션을 버리지 않는다 */
  get isLoading(): boolean {
    return this.loading !== undefined;
  }

  get isAlive(): boolean {
    return this.process === "alive" || this.process === "starting";
  }

  get isBusy(): boolean {
    return this.model.status.isTurnActive || this.model.pending.length > 0 || this.model.queued.length > 0
      || (this.model.status.backgroundTasks?.length ?? 0) > 0 || this.process === "starting";
  }

  /** 턴 말고 따로 기다리는 것 — 사람을 기다리는 요청·대기 입력·지금 턴에서 도는 도구 호출(잠자기 감시가 이어 가지 않는다) */
  get isWaiting(): boolean {
    if (this.model.pending.length > 0 || this.model.queued.length > 0) return true;
    for (let index = this.model.items.length - 1; index >= 0; index -= 1) {
      const content = this.model.items[index]!.content;
      if (content.kind === "user") return false;
      if (content.kind === "tool" && (content.call.state === "running" || content.call.state === "awaitingDecision")) return true;
    }
    return false;
  }

  /** 저장할 선택 — 다음 기동과 데몬 재시작 뒤에도 같은 값으로 띄운다 */
  get choices(): { effort?: EffortLevel; fastMode?: boolean } {
    return { ...(this.effortChoice !== undefined ? { effort: this.effortChoice } : {}), ...(this.fastModeChoice ? { fastMode: true } : {}) };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get lifecycle(): SessionLifecycle {
    return lifecycleOf(this.model, { alive: this.process === "alive", starting: this.process === "starting", failed: this.failed });
  }

  get title(): string {
    return this.customTitle ?? this.autoTitle ?? projectName(this.cwd);
  }

  /** 사람이 붙이지 않은 제목 — CLI 가 알린 제목, 기록의 AI 제목, 첫 프롬프트 순 */
  get autoTitle(): string | undefined {
    return this.model.status.sessionTitle ?? this.historyTitle ?? firstPromptLine(this.model);
  }

  /** 기록이 있는 세션은 처음 볼 때 기록을 재생해 모델을 채운다 */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= (async () => {
      const replayed = await this.host.history.load(this.id);
      const titles = this.host.history.titlesOfSession(this.id);
      this.historyTitle = titles?.customTitle ?? titles?.aiTitle;
      if (!this.loaded && replayed !== undefined) {
        replayed.status.cwd = replayed.status.cwd ?? this.cwd;
        replayed.status.permissionMode = this.modeChoice ?? replayed.status.permissionMode;
        replayed.status.model = this.modelChoice ?? replayed.status.model;
        replayed.status.effort = this.effortChoice ?? replayed.status.effort;
        replayed.queued = this.model.queued;
        replayed.pending = this.model.pending;
        this.model = replayed;
      }
      this.loaded = true;
      this.loading = undefined;
      this.channel.reset();
      this.host.changed(this);
    })();
    return this.loading;
  }

  // MARK: - 기동

  /** 떠 있지 않으면 띄운다 — 기록이 있으면 resume, 없으면 데몬이 정한 id 로 새로. 띄우는 중이면 그것을 기다린다 */
  start(): Promise<void> {
    if (this.process === "starting" && this.starting !== undefined) return this.starting;
    if (this.process !== "closed") return Promise.resolve();
    const starting = this.launch().finally(() => {
      // 닫고 다시 띄웠으면 뒤의 기동이 쥔 것을 지우지 않는다
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  private async launch(): Promise<void> {
    // 방금 닫은 이 데몬의 claude 가 아직 레지스트리에 남아 있을 수 있다(5초 주기) — 띄우기 직전에는 다시 읽는다
    const elsewhere = this.host.liveElsewhere(this.id, true);
    if (elsewhere !== undefined) throw new SessionError("이 세션은 Mac 의 다른 곳에서 열려 있습니다. 그쪽을 닫거나 사본으로 이어 가십시오.", 409);
    this.process = "starting";
    this.failed = false;
    this.failure = undefined;
    this.closing = false;
    this.notify();
    const generation = ++this.generation;
    try {
      const [executable, environment] = await Promise.all([this.host.claudeExecutable(), this.host.environment()]);
      if (executable === undefined) throw new Error("claude 실행 파일을 찾지 못했습니다. Claude Code 를 설치했는지, Mac 설정의 claude 경로가 맞는지 확인하십시오.");
      if (generation !== this.generation) return;
      // 아래의 폴더 설정 읽기(.mcp.json·.claude/settings*.json)는 동기다 — 폴더가 허용 창에 붙잡혀 있으면 데몬이 멈추기 전에 여기서 실패한다
      await this.host.ensureFolder(this.cwd);
      if (generation !== this.generation) return;
      const settings = this.host.settings();
      const resume = this.host.history.transcriptPath(this.id) !== undefined;
      const input = new InputQueue();
      this.input = input;
      this.stderrTail = "";
      this.exited = new Promise((resolve) => {
        this.markExited = resolve;
      });
      // 터미널이 띄우기 전에 묻는 프로젝트 MCP 서버는 끄고 띄운다 — SDK 는 묻지 않고 승인한다
      const home = environment.HOME ?? process.env.HOME ?? "";
      const unapproved = pendingProjectMcpServers(this.cwd, home, this.modeChoice);
      // 터미널처럼 백그라운드 Bash 에 시한을 걸지 않는다 — 포그라운드는 훅이 터미널 값으로 맞춘다
      const bashTimeouts = terminalBashTimeouts(environment, home, this.cwd);
      const options: Options = {
        ...launchOptions({
          cwd: this.cwd,
          additionalDirectories: [this.host.uploads.sessionDirectory(this.id)], bashTimeouts,
          thinkingDisplay: thinkingDisplay(home, this.cwd), disabledMcpServers: unapproved,
          ...settingsPlan(settings, this.model.tasks),
          ...(this.modelChoice !== undefined ? { model: this.modelChoice } : {}),
          ...(this.modeChoice !== undefined ? { permissionMode: this.modeChoice } : {}),
          ...(this.effortChoice !== undefined ? { effort: this.effortChoice } : {}),
          ...(this.fastModeChoice ? { fastMode: true } : {}),
          ...(resume ? { resume: this.id, ...(this.resumeAt !== undefined ? { resumeAt: this.resumeAt } : {}) } : { sessionId: this.id }),
        }, environment, executable),
        canUseTool: this.canUseTool,
        onElicitation: this.onElicitation,
        onUserDialog: this.onUserDialog,
        spawnClaudeCodeProcess: this.spawnProcess,
        stderr: this.captureStderr,
      };
      const spare = resume ? undefined : this.spare;
      this.spare = undefined;
      if (spare !== undefined) {
        this.claimSpare(spare, input, options, generation);
      } else {
        const query = this.host.query({ prompt: input, options });
        this.query = query;
        void this.pump(query, generation);
        this.readStatus(query, generation);
      }
      this.process = "alive";
      this.lastActivity = Date.now();
      log("info", "session started", { session: this.id, resume, spare: spare !== undefined });
      if (unapproved.length > 0) {
        this.apply({ kind: "localNotice", notice: {
          kind: "info",
          text: `이 폴더의 .mcp.json 서버 ${unapproved.join(", ")} 는 아직 승인하지 않아 끄고 띄웠습니다. Mac 터미널의 claude 에서 승인하면 다음에 열 때부터 씁니다.`,
        } });
      }
      this.notify();
    } catch (error) {
      if (generation !== this.generation) return;
      this.process = "closed";
      this.failed = true;
      this.failure = errorText(error);
      this.apply({ kind: "processExited", code: 1, message: this.failure });
      this.host.attention(this, { kind: "error", message: this.failure });
      log("error", "session start failed", { session: this.id, error: this.failure });
      throw new SessionError(this.failure, 500);
    }
  }

  /**
   * 예비를 claim 한다. 확정될 때까지 메시지를 붙잡고, 거절되면(프롬프트는 돌지 않았다 — d.ts) 꺼내 간 입력을 되감아
   * 보통의 `query()` 로 띄운다. `option_not_applied` 는 claim 은 된 것이다 — 모델만 못 바꿨다
   */
  private claimSpare(spare: TakenSpare, input: InputQueue, options: Options, generation: number): void {
    spare.bind({
      canUseTool: this.canUseTool, onElicitation: this.onElicitation, onUserDialog: this.onUserDialog, stderr: this.captureStderr,
      spawned: (child) => {
        this.child = child as unknown as ChildProcess;
      },
    });
    this.held = [];
    const query = spare.process.claim({ prompt: input, options: claimOptions(options) });
    this.query = query;
    void this.pump(query, generation);
    const release = () => {
      const held = this.held ?? [];
      this.held = undefined;
      for (const message of held) this.handleMessage(message);
      // 제어 요청은 claim 이 확정된 뒤에 — 그 전의 쿼리는 아직 이 세션의 것이 아니다
      if (generation === this.generation) {
        this.readStatus(query, generation);
        this.requestTitle();
      }
    };
    spare.process.claimed.then((claim) => {
      if (claim.sessionId !== this.id) log("warn", "spare session id differs", { session: this.id, claimed: claim.sessionId });
      release();
    }, (error: unknown) => {
      if (errorText(error).startsWith("option_not_applied")) {
        release();
        return;
      }
      if (generation !== this.generation || this.process !== "alive") return;
      log("warn", "spare claim refused", { session: this.id, error: errorText(error) });
      this.held = undefined;
      try {
        spare.process.close();
      } catch {
        // 이미 내려갔다
      }
      const fresh = input.rewind();
      this.input = fresh;
      const cold = ++this.generation;
      const coldQuery = this.host.query({ prompt: fresh, options });
      this.query = coldQuery;
      void this.pump(coldQuery, cold);
      this.readStatus(coldQuery, cold);
      this.requestTitle();
    });
  }

  // MARK: - 적용값 읽기

  /**
   * 띄운 뒤 한 번 — 모델 목록(새 세션 화면), 적용 중인 모델·노력도, 컨텍스트 창. 턴 없이도 답한다(실측).
   * 못 읽어도 세션은 돈다 — 화면이 그 값을 덜 보일 뿐이다
   */
  private readStatus(query: Query, generation: number): void {
    void (async () => {
      try {
        const init = await query.initializationResult();
        if (init.models.length > 0) this.host.modelsSeen(init.models);
      } catch {
        // 목록은 새 세션 화면의 덤이다 — 없으면 화면이 내장 목록을 쓴다
      }
    })();
    void this.readApplied(query, generation);
    void this.readContext(query, generation);
  }

  /** `get_settings` 의 `applied{model, effort}` — SDK 타입 선언 밖 메서드라(0.3.308 sdk.mjs 에만 있다) 있는지 보고 부른다 */
  private async readApplied(query: Query, generation: number): Promise<void> {
    const read = (query as Query & { getSettings?: () => Promise<unknown> }).getSettings;
    if (typeof read !== "function") return;
    try {
      const applied = jget((await read.call(query)) as JSONValue, "applied");
      if (applied === undefined || generation !== this.generation) return;
      const model = jstr(jget(applied, "model"));
      this.apply({ kind: "appliedSettings", effort: jstr(jget(applied, "effort")) ?? null, ...(model !== undefined ? { model } : {}) });
    } catch (error) {
      if (generation === this.generation) log("warn", "get_settings failed", { session: this.id, error: errorText(error) });
    }
  }

  /** 컨텍스트 창 — summary 는 API 를 부르지 않고 마지막 응답의 사용량으로 답한다(실측) */
  private async readContext(query: Query, generation: number): Promise<void> {
    try {
      const usage = await query.getContextUsage({ detail: "summary" }) as unknown as JSONValue;
      const used = jnum(jget(usage, "totalTokens"));
      const max = jnum(jget(usage, "maxTokens"));
      if (used === undefined || max === undefined || max <= 0 || generation !== this.generation) return;
      const autoCompactAt = jget(usage, "isAutoCompactEnabled") === true ? jnum(jget(usage, "autoCompactThreshold")) : undefined;
      this.apply({ kind: "contextUsage", used, window: { max, ...(autoCompactAt !== undefined ? { autoCompactAt } : {}) } });
    } catch (error) {
      if (generation === this.generation) log("warn", "get_context_usage failed", { session: this.id, error: errorText(error) });
    }
  }

  private readonly spawnProcess = (options: SpawnOptions): SpawnedProcess => {
    const child = spawnClaude(options, this.captureStderr);
    this.child = child;
    return asSpawned(child);
  };

  private readonly captureStderr = (data: string): void => {
    this.stderrTail = (this.stderrTail + data).slice(-8_192);
  };

  private async pump(query: Query, generation: number): Promise<void> {
    let code = 0;
    let failure: string | undefined;
    try {
      for await (const message of query) {
        if (generation !== this.generation) break;
        if (this.held !== undefined) this.held.push(message as unknown as JSONValue);
        else this.handleMessage(message as unknown as JSONValue);
      }
    } catch (error) {
      code = 1;
      failure = errorText(error);
    }
    if (generation !== this.generation) return;
    this.finish(code, failure);
  }

  private finish(code: number, failure: string | undefined): void {
    const intentional = this.closing;
    this.process = "closed";
    this.query = undefined;
    this.input = undefined;
    this.child = undefined;
    for (const waiter of this.waiters.values()) waiter(undefined);
    this.waiters.clear();
    // 기록에만 붙인 줄의 빈 result 는 이 프로세스와 함께 사라졌다
    this.silentPending = 0;
    if (intentional) {
      this.apply({ kind: "processExited", code: 0 });
    } else {
      const tail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
      const message = code === 0 ? undefined : [failure, tail].filter((part) => part !== undefined && part !== "").join("\n");
      this.failed = code !== 0;
      this.failure = message;
      this.apply({ kind: "processExited", code, ...(message !== undefined ? { message } : {}) });
      if (message !== undefined) this.host.attention(this, { kind: "error", message });
    }
    log(code === 0 || intentional ? "info" : "warn", "session exited", { session: this.id, code, intentional });
    this.closing = false;
    this.markExited();
    this.notify();
  }

  private handleMessage(message: JSONValue): void {
    const inbound = decodeInbound(message);
    // 기록에만 붙인 줄마다 오는 빈 init·result — 턴을 열고 닫지 않고 알림도 내지 않는다
    const quiet = this.silentPending > 0
      && ((inbound.kind === "systemInit" && !this.model.status.isTurnActive) || (inbound.kind === "result" && (inbound.result.numTurns ?? 1) === 0));
    this.apply({ kind: "inbound", inbound, ...(quiet ? { quiet: true } : {}) });
    if (inbound.kind !== "result") return;
    if (quiet) {
      this.silentPending -= 1;
      return;
    }
    this.lastActivity = Date.now();
    // 되감은 자리 뒤로 턴이 돌았다 — 이제 새 갈래가 끝 잎이다
    if (!inbound.result.isError) this.resumeAt = undefined;
    if (this.query !== undefined) void this.readContext(this.query, this.generation);
    const titles = this.host.history.titlesOfSession(this.id);
    if (titles?.customTitle !== undefined || titles?.aiTitle !== undefined) this.historyTitle = titles.customTitle ?? titles.aiTitle;
    const interrupted = this.interruptRequested;
    this.interruptRequested = false;
    if (this.model.queued.length > 0) {
      void this.flushQueue();
      return;
    }
    if (inbound.result.isError && !interrupted) {
      this.host.attention(this, { kind: "error", message: inbound.result.resultText ?? inbound.result.subtype });
    } else if (!inbound.result.isError && this.model.pending.length === 0) {
      this.host.attention(this, { kind: "turnDone" });
    }
  }

  private apply(event: ConversationEvent): void {
    ConversationReducer.apply(event, this.model);
    this.channel.markDirty();
    this.notify();
  }

  private notify(): void {
    this.host.changed(this);
  }

  // MARK: - 보내기

  /**
   * 사람 메시지 — 턴이 도는 중이면 대기열에 쌓는다. 프로세스가 닫혀 있으면 resume 으로 다시 연다.
   * 첨부는 보낼 때 꺼낸다 — 대기열의 것은 턴이 끝나 보낼 때. 첨부 없는 폰 명령(`/btw`·`/background`·`!`)은 여기서 처리한다
   */
  async send(text: string, attachments: readonly string[], mode: "queue" | "now", snippets: readonly AttachedSnippet[] = []): Promise<{ queued: boolean }> {
    if (this.origin === "history") throw new SessionError("Mac 기록 세션입니다. 먼저 이어받기를 누르십시오.", 409);
    for (const id of attachments) {
      if (this.host.uploads.info(id) === undefined) throw new SessionError("첨부를 찾지 못했습니다. 다시 올려 주십시오.", 404);
    }
    if (text.trim() === "" && attachments.length === 0 && snippets.length === 0) throw new SessionError("보낼 내용이 없습니다.");
    if (text.trim() !== "") this.host.recordPrompt(this, text.trim());
    const command = attachments.length === 0 && snippets.length === 0 ? parseNativeCommand(text) : undefined;
    if (command !== undefined && command.kind !== "fork") {
      await this.runCommand(command);
      return { queued: false };
    }
    if (command?.kind === "fork" && command.directive === "") {
      this.apply({ kind: "localNotice", notice: { kind: "info", text: `맡길 일을 함께 적으십시오 · /${command.name} <지시>` } });
      return { queued: false };
    }
    if (this.isAlive && this.model.status.isTurnActive && mode === "queue") {
      this.apply({ kind: "queue", message: { id: randomUUID(), text, attachments: [...attachments], ...(snippets.length > 0 ? { snippets: [...snippets] } : {}) } });
      return { queued: true };
    }
    await this.deliver(outgoingText(text), attachments, snippets);
    return { queued: false };
  }

  private async runCommand(command: Exclude<ReturnType<typeof parseNativeCommand>, undefined>): Promise<void> {
    switch (command.kind) {
      case "btw":
        if (command.question === "") this.apply({ kind: "localNotice", notice: { kind: "info", text: "질문을 함께 적으십시오 · /btw <질문>" } });
        else void this.sideQuestion(command.question);
        return;
      case "background":
        await this.background();
        return;
      case "shell":
        if (command.command === "") this.apply({ kind: "localNotice", notice: { kind: "info", text: "돌릴 명령을 함께 적으십시오 · ! <명령>" } });
        else if (this.model.status.isTurnActive) this.apply({ kind: "localNotice", notice: { kind: "info", text: "응답이 끝난 뒤 셸 명령을 실행할 수 있습니다." } });
        else void this.shell(command.command);
        return;
      case "fork":
        return;
    }
  }

  /** 떠 있게 한다 — 기록을 읽고, 닫히는 중이면 다 닫힌 뒤, 닫혀 있으면 다시 연다 */
  private async ensureAlive(): Promise<InputQueue> {
    await this.ensureLoaded();
    if (this.process === "closing") await this.exited;
    if (this.process !== "alive") await this.start();
    const input = this.input;
    if (input === undefined) throw new SessionError("세션이 아직 뜨지 않았습니다.", 503);
    return input;
  }

  private async deliver(text: string, attachments: readonly string[], snippets: readonly AttachedSnippet[] = []): Promise<void> {
    const input = await this.ensureAlive();
    const consumed = this.host.uploads.consume(attachments, this.id);
    const fullText = composeAttachments(text, consumed.files, snippets);
    const content: JSONObject[] = [
      ...consumed.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      ...consumed.documents.map((document) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: document.data }, title: document.title })),
      ...(fullText.trim() !== "" ? [{ type: "text", text: fullText }] : []),
    ];
    this.interruptRequested = false;
    input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null } as unknown as SDKUserMessage);
    this.apply({
      kind: "localUser", id: `local-${randomUUID()}`, text: fullText, images: consumed.images,
      ...(consumed.documents.length > 0 ? { documents: consumed.documents.map((document) => document.title) } : {}),
    });
    this.lastActivity = Date.now();
    if (this.wantsTitle && text.trim() !== "") {
      this.titleText ??= text.trim();
      this.requestTitle();
    }
  }

  /** 데몬이 사람 대신 보내는 「이어 가라」 턴 — 출처는 `auto-continuation`, 화면에는 안내 줄 */
  async continueWith(continuation: { prompt: string; display: string }): Promise<void> {
    if (this.origin !== "light") return;
    const input = await this.ensureAlive();
    this.interruptRequested = false;
    input.push({
      type: "user", message: { role: "user", content: [{ type: "text", text: continuation.prompt }] }, parent_tool_use_id: null,
      origin: { kind: "auto-continuation" },
    } as unknown as SDKUserMessage);
    this.apply({ kind: "localAutoContinue", display: continuation.display });
    this.lastActivity = Date.now();
  }

  /** 잠든 사이 멈춘 턴 — 그 턴을 끊고 이어 가라는 턴을 보낸다 */
  continueAfterSleep(): void {
    void (async () => {
      try {
        await this.interrupt();
        await this.continueWith(SLEEP_CONTINUATION);
      } catch (error) {
        log("warn", "sleep continuation failed", { session: this.id, error: errorText(error) });
      }
    })();
  }

  /**
   * 첫 메시지로 세션 제목을 짓는다 — 데스크톱 앱처럼 턴이 끝나기를 기다리지 않고 보낸 순간 부탁한다(`generateSessionTitle`,
   * SDK 타입 선언 밖 메서드라 있는지 보고 부른다). CLI 가 기록에 남긴다. 사람이 붙인 제목이 있으면 짓지 않고, 실패하면 기록의 AI 제목을 기다린다
   */
  private requestTitle(): void {
    const query = this.query;
    const description = this.titleText;
    if (!this.wantsTitle || description === undefined || query === undefined || this.held !== undefined || this.process !== "alive") return;
    this.wantsTitle = false;
    const generate = (query as Query & { generateSessionTitle?: (description: string, options: { persist: boolean }) => Promise<unknown> }).generateSessionTitle;
    if (typeof generate !== "function") return;
    void generate.call(query, description, { persist: true }).then((title) => {
      if (typeof title !== "string" || title.trim() === "" || this.customTitle !== undefined) return;
      this.historyTitle = title.trim();
      this.channel.markDirty();
      this.notify();
    }, (error: unknown) => log("warn", "title generation failed", { session: this.id, error: errorText(error) }));
  }

  /** 대기열을 한 턴으로 — 문단으로 잇고 첨부·인용은 모은다. fork 지시는 하나씩 모델에게 보낼 글로 바꾼다 */
  private async flushQueue(): Promise<void> {
    const queued = this.model.queued;
    if (queued.length === 0) return;
    for (const message of queued) this.apply({ kind: "unqueue", id: message.id });
    const text = queued.map((message) => outgoingText(message.text)).filter((part) => part.trim() !== "").join("\n\n");
    try {
      await this.deliver(text, queued.flatMap((message) => message.attachments), queued.flatMap((message) => message.snippets ?? []));
    } catch (error) {
      this.apply({ kind: "localNotice", notice: { kind: "error", text: `대기 중이던 메시지를 보내지 못했습니다: ${errorText(error)}` } });
    }
  }

  cancelQueued(queueId: string): boolean {
    if (!this.model.queued.some((message) => message.id === queueId)) return false;
    this.apply({ kind: "unqueue", id: queueId });
    return true;
  }

  /** 대기 중인 메시지를 지금 끼워 넣는다 — 진행 중 턴에 합쳐진다(실측) */
  async sendQueuedNow(queueId: string): Promise<boolean> {
    const message: QueuedMessage | undefined = this.model.queued.find((candidate) => candidate.id === queueId);
    if (message === undefined) return false;
    this.apply({ kind: "unqueue", id: queueId });
    await this.deliver(outgoingText(message.text), message.attachments, message.snippets ?? []);
    return true;
  }

  // MARK: - 조작

  /** 진행 중인 턴을 끊는다 — `perTaskStopAffordance` 를 걸어 백그라운드 작업은 산다. 작업은 `stopTask` 로 하나씩 멈춘다 */
  async interrupt(): Promise<void> {
    if (this.query === undefined || this.process !== "alive") return;
    this.interruptRequested = true;
    await this.query.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.query !== undefined && this.process === "alive") await this.query.setPermissionMode(mode);
    this.modeChoice = mode;
    this.model.status.permissionMode = mode;
    this.host.rememberMode(this.cwd, mode);
    this.channel.markDirty();
    this.notify();
  }

  /** 별칭("sonnet")이 실제 모델로 풀리고, 모델이 바뀌면 노력도가 그 모델에 맞게 바뀔 수 있다 — 바꾼 뒤 적용값을 다시 읽는다 */
  async setModel(model: string): Promise<void> {
    // claude 목록의 「default」 줄은 기본 모델로 돌리는 것이다 — SDK 는 undefined 로 받는다(d.ts `setModel`)
    const target = model === "default" || model === "" ? undefined : model;
    const query = this.process === "alive" ? this.query : undefined;
    if (query !== undefined) await query.setModel(target);
    this.modelChoice = target;
    // 기본으로 돌리면 실제 모델은 아래 적용값 읽기가 채운다
    this.model.status.model = target;
    this.channel.markDirty();
    this.notify();
    if (query !== undefined) await this.readApplied(query, this.generation);
  }

  /**
   * 노력도 — 세션 플래그 층에 얹는다(`applyFlagSettings`, 대화에 아무것도 남기지 않는다). `null` 은 모델 기본값으로 돌린다.
   * 터미널의 /effort 와 달리 사용자 설정 파일에는 남기지 않는다 — 폰에서 바꾼 값이 Mac 터미널의 기본값을 바꾸지 않게
   */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    const query = this.process === "alive" ? this.query : undefined;
    if (query !== undefined) await query.applyFlagSettings({ effortLevel: effort });
    this.effortChoice = effort ?? undefined;
    this.model.status.effort = effort ?? undefined;
    this.channel.markDirty();
    this.notify();
    if (query !== undefined) await this.readApplied(query, this.generation);
  }

  /**
   * 빠른 모드 — 플래그 층의 `fastMode`. SDK 경로는 이 층의 값으로만 연다(실측). 다음 턴부터 적용되고 상태는 그 턴의 init·result 가 알린다.
   * 켜도 소용없는 까닭을 이미 알면 얹지 않고 까닭만 알린다
   */
  async setFastMode(on: boolean): Promise<void> {
    const blocked = on ? fastModeBlockedText(this.model.status.fastMode?.disabledReason) : undefined;
    if (blocked !== undefined) {
      this.apply({ kind: "localNotice", notice: { kind: "info", text: blocked } });
      return;
    }
    const query = this.process === "alive" ? this.query : undefined;
    if (query !== undefined) await query.applyFlagSettings({ fastMode: on });
    this.fastModeChoice = on;
    this.apply({ kind: "localNotice", notice: { kind: "info", text: on ? "빠른 모드를 켰습니다. 다음 턴부터 적용됩니다." : "빠른 모드를 껐습니다. 다음 턴부터 적용됩니다." } });
  }

  /** 백그라운드 작업 하나를 멈춘다 — 중단은 턴만 끊으므로(`perTaskStopAffordance`) 작업은 이 길로만 멈춘다 */
  async stopTask(taskId: string): Promise<void> {
    if (!(this.model.status.backgroundTasks ?? []).some((task) => task.id === taskId)) return;
    if (this.query === undefined || this.process !== "alive") throw new SessionError("세션이 떠 있지 않습니다.", 409);
    await this.query.stopTask(taskId);
  }

  /**
   * /background — 도는 포그라운드 도구를 백그라운드로 넘긴다(터미널의 Ctrl+B). 도구가 막 시작했으면 아직 작업으로 등록되지 않아
   * 넘길 것이 없다(실측: Bash 시작 뒤 약 3초에 task_started) — 그렇게 알린다
   */
  async background(): Promise<void> {
    const query = this.process === "alive" ? this.query : undefined;
    if (query === undefined || !this.model.status.isTurnActive) {
      this.apply({ kind: "localNotice", notice: { kind: "info", text: "지금 도는 도구가 없습니다." } });
      return;
    }
    const moved = await query.backgroundTasks();
    if (!moved) this.apply({ kind: "localNotice", notice: { kind: "info", text: "백그라운드로 넘길 작업이 아직 없습니다. 도구가 막 시작했다면 몇 초 뒤 다시 누르십시오." } });
  }

  /**
   * /btw — 곁가지 질문. 도구 없이 본 대화를 보고 답하고 대화에는 남지 않는다(터미널과 같다). 답은 이 화면의 안내 줄이다.
   * 앞서 물은 곁가지 질문과 답을 함께 보내 이어 묻게 한다. 질문이 잘못돼도 CLI 는 성공으로 답하고 `synthetic` 에 내부 문구를 싣는다(실측)
   */
  private async sideQuestion(question: string): Promise<void> {
    try {
      await this.ensureAlive();
      const query = this.query;
      const ask = (query as (Query & { askSideQuestion?: (question: string, options: { history: { question: string; response: string }[] }) => Promise<unknown> }) | undefined)?.askSideQuestion;
      if (query === undefined || typeof ask !== "function") throw new Error("이 claude 는 곁가지 질문을 받지 않습니다.");
      const reply = await Promise.race([
        ask.call(query, question, { history: [...this.sideQuestions] }),
        sleep(SIDE_QUESTION_TIMEOUT_MS).then(() => { throw new Error("답이 90초 안에 오지 않았습니다."); }),
      ]);
      const response = jstr(jget(reply as JSONValue, "response"));
      if (response === undefined || jget(reply as JSONValue, "synthetic") === true) throw new Error(response ?? "답이 없습니다.");
      this.sideQuestions.push({ question, response });
      this.apply({ kind: "localNotice", notice: { kind: "side", text: `${question}\n\n${response.trim()}` } });
    } catch (error) {
      this.apply({ kind: "localNotice", notice: { kind: "error", text: `곁가지 질문에 답하지 못했습니다 · ${errorText(error).split("\n")[0]}` } });
    }
  }

  /**
   * `! <명령>` — 셸 모드. 세션과 같은 로그인 셸 env 로 작업 폴더에서 돌리고, 입력·출력을 터미널과 같은 user 줄 둘로
   * 기록에 붙인다(`shouldQuery: false` — 모델 턴은 없고 다음 턴에 모델이 읽는다, 실측). 출력은 터미널처럼 HTML 이스케이프한다
   */
  private async shell(command: string): Promise<void> {
    try {
      const input = await this.ensureAlive();
      const append = (text: string) => {
        this.silentPending += 1;
        input.push({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, shouldQuery: false } as unknown as SDKUserMessage);
        this.apply({ kind: "localContext", text });
      };
      append(`<bash-input>${command}</bash-input>`);
      const environment = await this.host.environment();
      const result = await runShell(environment.SHELL ?? "/bin/zsh", command, this.cwd, environment);
      if (this.input !== input) return;
      append(`<bash-stdout>${escapeShellOutput(tail(result.stdout))}</bash-stdout><bash-stderr>${escapeShellOutput(tail(result.stderr))}</bash-stderr>`);
      this.lastActivity = Date.now();
    } catch (error) {
      this.apply({ kind: "localNotice", notice: { kind: "error", text: `셸 명령을 돌리지 못했습니다 · ${errorText(error)}` } });
    }
  }

  /** 백그라운드 작업의 출력(`getTaskOutput`, SDK 타입 선언 밖 메서드) — 떠 있는 프로세스만 안다 */
  async taskOutput(taskId: string): Promise<TaskOutput> {
    const query = this.process === "alive" ? this.query : undefined;
    const read = (query as (Query & { getTaskOutput?: (taskId: string) => Promise<unknown> }) | undefined)?.getTaskOutput;
    if (query === undefined || typeof read !== "function") throw new SessionError("세션이 떠 있지 않아 작업 출력을 읽지 못합니다.", 409);
    const reply = (await read.call(query, taskId)) as JSONValue;
    const total = jnum(jget(reply, "total_bytes"));
    return { output: jstr(jget(reply, "output")) ?? "", truncated: jget(reply, "truncated") === true, ...(total !== undefined ? { totalBytes: total } : {}) };
  }

  /** 되감을 수 있는 자리 — 기록의 사람 메시지, 최근 것부터 */
  rewindPoints(): Promise<RewindPoint[]> {
    return this.host.history.rewindPoints(this.id);
  }

  /**
   * 되감기 — 코드는 떠 있는 프로세스의 파일 체크포인트로 돌리고(`rewindFiles`), 대화는 프로세스를 닫은 뒤 그 메시지 앞의
   * assistant 까지만 이어 연다(`resumeSessionAt`, 같은 session id 에 새 갈래). 살아 있는 세션을 그대로 resume 하지 않는다 — 순서가 안전장치다.
   * `dryRun` 이면 코드 쪽 바뀔 파일만 센다. 되감은 메시지의 글을 돌려준다 — 화면이 입력창에 돌려 둔다
   */
  async rewind(pointId: string, scope: RewindScope, dryRun: boolean): Promise<{ preview?: RewindPreview; draft?: string }> {
    if (this.origin !== "light") throw new SessionError("light 세션이 아닙니다.", 409);
    if (this.model.status.isTurnActive || this.model.pending.length > 0) throw new SessionError("턴이 끝난 뒤 되감을 수 있습니다.", 409);
    const point = (await this.rewindPoints()).find((candidate) => candidate.id === pointId);
    if (point === undefined) throw new SessionError("되감을 메시지를 찾지 못했습니다.", 404);
    const code = scope !== "conversation";
    const conversation = scope !== "code";
    if (conversation && point.resumeAt === undefined) throw new SessionError("첫 메시지로는 대화를 되감을 수 없습니다. 새 세션을 여십시오.", 409);
    if (code) {
      await this.ensureAlive();
      const query = this.query;
      if (query === undefined) throw new SessionError("세션이 아직 뜨지 않았습니다.", 503);
      const result = await query.rewindFiles(pointId, { dryRun });
      const preview: RewindPreview = {
        canRewind: result.canRewind, ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.filesChanged !== undefined ? { filesChanged: result.filesChanged } : {}),
        ...(result.insertions !== undefined ? { insertions: result.insertions } : {}), ...(result.deletions !== undefined ? { deletions: result.deletions } : {}),
      };
      if (dryRun) return { preview };
      if (!result.canRewind) throw new SessionError(`코드를 되돌리지 못했습니다: ${result.error ?? "체크포인트가 없습니다"}`, 409);
    } else if (dryRun) {
      return { preview: { canRewind: true } };
    }
    if (conversation) {
      await this.close("rewind");
      this.resumeAt = point.resumeAt;
      const replayed = await this.host.history.load(this.id, point.resumeAt);
      if (replayed !== undefined) {
        replayed.status.cwd = replayed.status.cwd ?? this.cwd;
        replayed.status.permissionMode = this.modeChoice ?? replayed.status.permissionMode;
        replayed.status.model = this.modelChoice ?? replayed.status.model;
        replayed.status.effort = this.effortChoice ?? replayed.status.effort;
        this.model = replayed;
        this.loaded = true;
      }
      this.channel.reset();
    }
    this.apply({ kind: "localNotice", notice: { kind: "info", text: code && conversation ? "대화와 코드를 되감았습니다." : conversation ? "대화를 되감았습니다." : "코드를 되감았습니다." } });
    return { draft: point.text };
  }

  // MARK: - 권한 중계

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = options.requestId ?? `permission-${++this.permissionCounter}`;
    const pending = newPermissionPending(requestId, {
      toolName, input: input as JSONValue, toolUseID: options.toolUseID,
      suggestions: (options.suggestions ?? []) as unknown as JSONValue[],
      ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.decisionReason !== undefined ? { decisionReason: options.decisionReason } : {}),
      ...(options.suppressAlwaysAllowRule === true ? { suppressAlwaysAllowRule: true } : {}),
      ...(options.agentID !== undefined ? { agentID: options.agentID } : {}),
      ...(options.blockedPath !== undefined ? { blockedPath: options.blockedPath } : {}),
    }, Date.now(), this.cwd);
    return this.ask<PermissionResult>(requestId, pending, options.signal, (answer) => {
      const decision = (answer as PermissionDecision | undefined) ?? NO_ANSWER;
      return decision as unknown as PermissionResult;
    });
  };

  private readonly onElicitation: OnElicitation = (request, options) => {
    const pending = newElicitationPending(options.requestId, Date.now(), {
      serverName: request.serverName, message: request.message,
      ...(request.mode !== undefined ? { mode: request.mode } : {}), ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.requestedSchema !== undefined ? { requestedSchema: request.requestedSchema as JSONValue } : {}),
    });
    return this.ask<ElicitationResult>(options.requestId, pending, options.signal,
      (answer) => (answer as ElicitationResult | undefined) ?? { action: "cancel" });
  };

  private readonly onUserDialog: OnUserDialog = (request, options) => {
    const pending = newDialogPending(options.requestId, Date.now(), request.dialogKind, request.payload as JSONValue);
    return this.ask<UserDialogResult>(options.requestId, pending, options.signal,
      (answer) => (answer as UserDialogResult | undefined) ?? { behavior: "cancelled" });
  };

  private ask<T>(requestId: string, pending: PendingInteraction, signal: AbortSignal, decode: (answer: Parameters<Waiter>[0]) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (this.process !== "alive") {
        resolve(decode(undefined));
        return;
      }
      this.waiters.set(requestId, (answer) => resolve(decode(answer)));
      signal.addEventListener("abort", () => {
        // CLI 가 요청을 거뒀다 — 카드를 닫는다
        if (!this.waiters.delete(requestId)) return;
        this.apply({ kind: "resolved", requestID: requestId });
        resolve(decode(undefined));
      }, { once: true });
      this.apply({ kind: "pending", pending });
      this.host.attention(this, { kind: "pending", pending });
    });
  }

  /** 기기의 답 — requestId 마다 먼저 온 답 하나만 반영한다 */
  respond(requestId: string, answer: ClientAnswer): "ok" | "handled" | "invalid" {
    const waiter = this.waiters.get(requestId);
    const pending = this.model.pending.find((candidate) => candidate.requestID === requestId);
    if (waiter === undefined || pending === undefined) return "handled";
    let decision: Parameters<Waiter>[0];
    if (isPermissionPending(pending)) {
      decision = decisionFor(pending, answer);
    } else if (pending.kind === "elicitation" && answer.kind === "elicitation") {
      decision = answer.action === "accept" && answer.content !== undefined
        ? { action: "accept", content: answer.content } : { action: answer.action };
    } else if (pending.kind === "dialog" && answer.kind === "dialog") {
      decision = answer.choice !== undefined && pending.choices.some((choice) => choice.id === answer.choice)
        ? { behavior: "completed", result: answer.choice } : { behavior: "cancelled" };
    }
    if (decision === undefined) return "invalid";
    this.waiters.delete(requestId);
    waiter(decision);
    this.apply({ kind: "resolved", requestID: requestId });
    this.lastActivity = Date.now();
    return "ok";
  }

  // MARK: - 닫기

  /** interrupt → 입력 닫기 → 유예 → SIGTERM → SIGKILL. 데몬이 끝날 때는 모든 세션이 이 길로 닫힌다 */
  async close(reason: string): Promise<void> {
    if (this.process === "closed") return;
    if (this.process === "starting") {
      this.generation += 1;
      this.process = "closed";
      this.notify();
      return;
    }
    this.closing = true;
    this.process = "closing";
    this.notify();
    log("info", "session closing", { session: this.id, reason });
    const query = this.query;
    const child = this.child;
    if (this.model.status.isTurnActive && query !== undefined) {
      await Promise.race([query.interrupt().catch(() => undefined), sleep(2_000)]);
    }
    this.input?.end();
    if (await waitOrTimeout(this.exited, STOP_WAIT_MS)) return;
    if (child !== undefined && child.exitCode === null) child.kill("SIGTERM");
    if (await waitOrTimeout(this.exited, TERM_WAIT_MS)) return;
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    try {
      query?.close();
    } catch {
      // 이미 닫혔다
    }
    if (!(await waitOrTimeout(this.exited, 1_000))) this.finish(0, undefined);
  }

  // MARK: - 화면

  view(): SessionView {
    const status = this.model.status;
    const elsewhere = this.origin === "history" || !this.isAlive ? this.host.liveElsewhere(this.id) : undefined;
    return {
      sessionId: this.id, lifecycle: this.lifecycle, origin: this.origin, title: this.title, cwd: this.cwd,
      ...(status.model !== undefined ? { model: status.model } : {}),
      ...(status.permissionMode !== undefined ? { permissionMode: status.permissionMode } : {}),
      ...(isEffortLevel(status.effort) ? { effort: status.effort } : {}),
      fastMode: { requested: this.fastModeChoice, ...status.fastMode },
      isTurnActive: status.isTurnActive, isCompacting: status.isCompacting,
      ...(status.turnStartedAt !== undefined ? { turnStartedAt: status.turnStartedAt } : {}),
      ...(status.retryNotice !== undefined ? { retryNotice: status.retryNotice } : {}),
      ...(status.promptSuggestion !== undefined ? { promptSuggestion: status.promptSuggestion } : {}),
      ...(status.totalCostUSD !== undefined ? { totalCostUSD: status.totalCostUSD } : {}),
      ...(status.contextTokens !== undefined ? { contextTokens: status.contextTokens } : {}),
      ...(status.contextWindow !== undefined ? { contextWindow: status.contextWindow } : {}),
      ...(status.rateLimit !== undefined ? { rateLimit: status.rateLimit } : {}),
      pending: this.model.pending.map(clipPending), tasks: this.model.tasks, queued: this.model.queued,
      backgroundTasks: this.isAlive ? status.backgroundTasks ?? [] : [],
      ...(elsewhere !== undefined ? { liveElsewhere: elsewhere } : {}),
      slashCommands: status.slashCommands,
      ...(this.failure !== undefined && this.failed ? { error: this.failure } : {}),
    };
  }

  summary(): SessionSummary {
    const lastMessage = this.loaded ? lastMessageLine(this.model) ?? this.persistedLastMessage : this.persistedLastMessage;
    const elsewhere = this.isAlive ? undefined : this.host.liveElsewhere(this.id);
    return {
      id: this.id, hostId: this.host.hostId, cwd: this.cwd, project: projectName(this.cwd), title: this.title, origin: this.origin,
      lifecycle: this.lifecycle, pendingCount: this.model.pending.length, updatedAt: this.lastActivity,
      ...(lastMessage !== undefined ? { lastMessage } : {}),
      ...(elsewhere !== undefined ? { liveElsewhere: elsewhere } : {}),
      ...(this.model.status.model !== undefined ? { model: this.model.status.model } : {}),
      ...(this.model.status.permissionMode !== undefined ? { permissionMode: this.model.status.permissionMode } : {}),
      ...(this.archived ? { archived: true } : {}),
    };
  }

  /** 기록 세션을 이어받았다 — 이제 light 가 다룬다 */
  adopt(): void {
    this.origin = "light";
    this.channel.markDirty();
    this.notify();
  }

  image(id: string): { mediaType: string; data: string } | undefined {
    return this.model.images.get(id);
  }

  dispose(): void {
    this.channel.close();
  }
}

/** 모델에게 보낼 글 — fork 지시는 Agent 도구를 부르라는 글로(`commands.ts`), 그 밖은 그대로 */
function outgoingText(text: string): string {
  const command = parseNativeCommand(text);
  return command?.kind === "fork" && command.directive !== "" ? forkDirectivePrompt(command.directive) : text;
}

/** 셸 줄 하나를 돌린다 — 시한을 넘으면 내린다. 입력은 주지 않는다(대화형 명령은 끝나지 않는다) */
async function runShell(shell: string, command: string, cwd: string, environment: Readonly<Record<string, string>>): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([shell, "-c", command], { cwd, env: { ...environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, SHELL_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const status = timedOut ? `\n[${SHELL_TIMEOUT_MS / 1000}초가 지나 멈췄습니다]` : code !== 0 ? `\n[종료 코드 ${code}]` : "";
    return { stdout, stderr: `${stderr}${status}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

function tail(text: string): string {
  return text.length > SHELL_OUTPUT_TAIL ? `…\n${text.slice(-SHELL_OUTPUT_TAIL)}` : text;
}

function escapeShellOutput(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isEffortLevel(value: string | undefined): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value ?? "");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitOrTimeout(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  const result = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return result;
}
