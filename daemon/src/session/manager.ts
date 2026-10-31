/**
 * 세션 전부 — light 가 띄운 세션(색인에 있다)과 Mac 기록 세션(색인에 없다)을 한 목록으로 낸다.
 * - 기록 세션은 먼저 읽기 전용이고 이어받기를 누르면 resume 으로 띄운다
 * - Mac 터미널에서 살아 있는 세션은 그대로 resume 하지 않는다 — 사본으로 이어 가기(fork, 기본)와 가져오기 둘이다
 * - 유휴가 정해진 시간을 넘으면 프로세스를 닫고, 동시 실행 상한을 넘으면 가장 오래 쉰 세션부터 닫는다
 * - 데몬이 꺼지거나 Mac 이 잠든 사이 끊긴 턴은 다시 띄워 이어 가게 한다(`auto-continue.ts`, 설정 `autoContinue`)
 */
import { forkSession as sdkForkSession, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { randomUUID } from "node:crypto";
import { EFFORT_LEVELS, type EffortLevel, type ModelOption, type PermissionMode, type ProjectCandidate, type SessionSummary } from "../../../shared/src/protocol.ts";
import { lastMessageLine } from "../../../shared/src/session/conversation.ts";
import { pendingCategory, type PendingInteraction } from "../../../shared/src/session/pending.ts";
import type { LightSettings } from "../../../shared/src/settings.ts";
import { firstLine } from "../../../shared/src/session/tool-summary.ts";
import type { TurnWrapUp } from "../../../shared/src/session/turn-box.ts";
import { appendPromptHistory } from "../claude/prompt-history.ts";
import { projectName, type ClaudeHistory, type HistoryEntry } from "../claude/history.ts";
import { ClaudeSessionRegistry, type ClaudeSessionRecord } from "../claude/registry.ts";
import { resolveExecutable, type ShellEnvironment } from "../claude/shell-environment.ts";
import { signalUntilExit } from "../claude/termination.ts";
import { FolderAccess } from "../folder-access.ts";
import { errorText, log } from "../log.ts";
import type { Notifier } from "../push/notifier.ts";
import type { SettingsStore, StateStore } from "../stores.ts";
import type { Uploads } from "../uploads.ts";
import { LiveSession, SessionError, type AttentionEvent, type LiveSessionHost, type QueryFunction } from "./live-session.ts";
import { QUIT_RESUME, SleepWatch, pickInterrupted } from "./auto-continue.ts";
import { defaultSessionLimit, launchOptions, sessionEnvironment, settingsPlan } from "./options.ts";
import { SpareSessions, type Prewarm, type SpareTemplate } from "./spare.ts";
import { chromeEnvironment, terminalBashTimeouts, thinkingDisplay } from "./terminal-parity.ts";

export interface ManagerDeps {
  settings: SettingsStore;
  state: StateStore;
  history: ClaudeHistory;
  uploads: Uploads;
  notifier: Notifier;
  shell: ShellEnvironment;
  query: QueryFunction;
  claudeHome: string;
  /** 살아 있는 CLI 레지스트리 행 — 시험은 대역을 넣는다 */
  registry?: () => ClaudeSessionRecord[];
  fork?: (sessionId: string, title?: string) => Promise<string>;
  terminate?: (pid: number, busy: boolean) => Promise<boolean>;
  totalMemory?: number;
  /** 시험이 SDK `prewarm` 대신 꽂는다 */
  prewarm?: Prewarm;
  prewarmDelayMs?: number;
  /** 시험이 잠자기 감시의 시계를 바꾼다 */
  sleepWatch?: { now?: () => number; tickMs?: number; gapMs?: number; graceMs?: number };
  /** 시험이 폴더 읽기 대역을 꽂는다 */
  folderAccess?: FolderAccess;
}

/** 세션 첨부 폴더를 지우는 때 — 보관한 세션은 마지막 활동 뒤 30일, 색인에도 기록에도 없는 세션은 폴더를 마지막으로 고친 뒤 7일 */
const ARCHIVED_UPLOADS_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_UPLOADS_MS = 7 * 24 * 60 * 60 * 1000;

const HISTORY_LIMIT = 150;

export class SessionManager {
  readonly sessions = new Map<string, LiveSession>();
  private historyEntries: HistoryEntry[] = [];
  private liveRecords: ClaudeSessionRecord[] = [];
  private readonly listeners = new Set<(sessions: SessionSummary[]) => void>();
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBroadcast = "";
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly host: LiveSessionHost;
  private claudePathCache: { key: string; path: string | undefined } | undefined;
  /** 예열한 예비 세션 */
  private readonly spares: SpareSessions;
  /** claude 가 알려 준 모델 목록 — 세션이 뜰 때마다 새로 받는다 */
  private modelCache: { at: number; models: ModelOption[] } | undefined;
  private modelsLoading: Promise<ModelOption[]> | undefined;
  private readonly sleepWatch: SleepWatch;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  /** 데몬이 끝나는 중 — 세션을 닫으며 턴이 내려가도 상태 파일의 「턴이 돌던 중」 표시는 지우지 않는다(다음 기동이 이어 간다) */
  private stopping = false;
  /** 이 데몬이 띄운 claude 의 pid 와 마지막으로 본 때 — 닫은 뒤에도 잠시 쥔다. 5초 주기의 레지스트리에 남은 제 프로세스를 「다른 곳」으로 읽지 않게 */
  private readonly ownPids = new Map<number, number>();
  /** 세션 폴더를 동기로 읽기 전에 지나는 문 */
  private readonly folders: FolderAccess;

  constructor(private readonly deps: ManagerDeps) {
    this.folders = deps.folderAccess ?? new FolderAccess();
    this.host = {
      settings: () => deps.settings.current,
      // 셸 env 가 Chrome 값을 정했으면 그것이 이긴다
      environment: async () => {
        const shell = await deps.shell.environment();
        return { ...chromeEnvironment(shell.HOME ?? process.env.HOME ?? "/"), ...sessionEnvironment(shell, deps.settings.current.authMode) };
      },
      claudeExecutable: () => this.claudeExecutable(),
      uploads: deps.uploads,
      history: deps.history,
      query: deps.query,
      hostId: deps.state.hostId,
      changed: (session) => this.sessionChanged(session),
      attention: (session, event) => this.attention(session, event),
      liveElsewhere: (sessionId, fresh) => (fresh === true ? this.freshElsewhere(sessionId) : this.liveElsewhere(sessionId)),
      rememberMode: (cwd, mode) => deps.state.rememberFolder(cwd, mode),
      modelsSeen: (models) => {
        this.modelCache = { at: Date.now(), models: models.map(modelOption) };
      },
      recordPrompt: (session, display) => {
        if (!deps.settings.current.writePromptHistory) return;
        try {
          appendPromptHistory(deps.claudeHome, { display, project: session.cwd, sessionId: session.id, timestamp: Date.now() });
        } catch (error) {
          log("warn", "prompt history failed", { error: errorText(error) });
        }
      },
      ensureFolder: (folder) => this.folders.ensure(folder),
    };
    this.sleepWatch = new SleepWatch({
      ...deps.sleepWatch,
      // 설정이 끄면 지켜볼 세션이 없다 — 켜고 끄는 것이 데몬을 다시 띄우지 않아도 선다
      sessions: () => (!deps.settings.current.autoContinue ? [] : [...this.sessions.values()].filter((session) => session.origin === "light" && session.isAlive)).map((session) => ({
        id: session.id,
        turnStartedAt: () => (session.model.status.isTurnActive ? session.model.status.turnStartedAt : undefined),
        revision: () => session.model.revision,
        waiting: () => session.isWaiting,
        continueAfterSleep: () => session.continueAfterSleep(),
      })),
    });
    this.spares = new SpareSessions({
      template: () => this.spareTemplate(),
      ...(deps.prewarm !== undefined ? { prewarm: deps.prewarm } : {}), ...(deps.prewarmDelayMs !== undefined ? { delayMs: deps.prewarmDelayMs } : {}),
    });
    // 설정이 바뀌면 예비의 기동 값도 바뀌었을 수 있다 — 버리고 새로 예열한다
    deps.settings.onChange(() => {
      this.spares.discard();
      this.spares.schedule();
    });
    for (const persisted of deps.state.sessions()) {
      this.sessions.set(persisted.id, new LiveSession(this.host, {
        id: persisted.id, cwd: persisted.cwd, origin: "light", updatedAt: persisted.updatedAt,
        ...(persisted.title !== undefined ? { title: persisted.title } : {}),
        ...(persisted.autoTitle !== undefined ? { autoTitle: persisted.autoTitle } : {}),
        ...(persisted.lastMessage !== undefined ? { lastMessage: persisted.lastMessage } : {}),
        ...(persisted.model !== undefined ? { model: persisted.model } : {}),
        ...(persisted.permissionMode !== undefined ? { permissionMode: persisted.permissionMode as PermissionMode } : {}),
        ...(persisted.effort !== undefined ? { effort: persisted.effort } : {}),
        ...(persisted.fastMode === true ? { fastMode: true } : {}),
        ...(persisted.archived === true ? { archived: true } : {}),
      }));
    }
  }

  /** 주기 일 — 레지스트리·기록 다시 훑기, 유휴 정리, 잠자기 감시, 첨부 폴더 정리. 지난 실행이 끊은 턴을 이어 간다 */
  startTimers(): void {
    this.refresh();
    this.spares.schedule();
    this.sweepTimer = setInterval(() => {
      this.refresh();
      void this.sweepIdle();
    }, 5_000);
    this.sleepWatch.start();
    this.cleanupUploads();
    this.cleanupTimer = setInterval(() => this.cleanupUploads(), 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
    void this.resumeInterrupted();
  }

  /**
   * 지난 실행이 턴 도중에 끝났다 — 상태 파일에 「턴이 돌던 중」이 남은 세션 가운데 하루 안의 최근 넷을 다시 띄워 이어 가게 한다.
   * 나머지와 설정이 끈 경우는 표시만 지운다
   */
  async resumeInterrupted(now = Date.now()): Promise<string[]> {
    const turns = this.deps.state.sessions().flatMap((persisted) => (persisted.turnActiveAt === undefined ? [] : [{ id: persisted.id, at: persisted.turnActiveAt }]));
    if (turns.length === 0) return [];
    const { resume, dismiss } = this.deps.settings.current.autoContinue ? pickInterrupted(turns, now) : { resume: [], dismiss: turns };
    for (const turn of dismiss) this.deps.state.patchSession(turn.id, { turnActiveAt: undefined });
    const resumed: string[] = [];
    for (const turn of resume) {
      const session = this.sessions.get(turn.id);
      if (session === undefined || session.origin !== "light" || this.liveElsewhere(turn.id) !== undefined) {
        this.deps.state.patchSession(turn.id, { turnActiveAt: undefined });
        continue;
      }
      try {
        await this.makeRoom(session.id);
        await session.continueWith(QUIT_RESUME);
        resumed.push(session.id);
        log("info", "resumed interrupted turn", { session: session.id });
      } catch (error) {
        this.deps.state.patchSession(turn.id, { turnActiveAt: undefined });
        log("warn", "resume interrupted turn failed", { session: turn.id, error: errorText(error) });
      }
    }
    return resumed;
  }

  /** 세션 첨부 폴더 정리 — 보관하고 오래 쉰 세션, 색인에도 기록에도 없는 세션의 폴더 */
  cleanupUploads(now = Date.now()): string[] {
    const removed = this.deps.uploads.cleanupSessions((sessionId, modifiedAt) => {
      if (this.sessions.get(sessionId)?.isAlive === true) return false;
      const persisted = this.deps.state.session(sessionId);
      if (persisted !== undefined) return persisted.archived === true && now - persisted.updatedAt > ARCHIVED_UPLOADS_MS;
      return now - modifiedAt > ORPHAN_UPLOADS_MS && this.deps.history.transcriptPath(sessionId) === undefined;
    });
    if (removed.length > 0) log("info", "uploads cleaned", { sessions: removed.length });
    return removed;
  }

  onSessions(listener: (sessions: SessionSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    try {
      this.liveRecords = this.readRegistry();
      this.historyEntries = this.deps.history.entries(HISTORY_LIMIT);
    } catch (error) {
      log("warn", "refresh failed", { error: errorText(error) });
    }
    // 보는 화면의 「다른 곳에서 열림」도 새로 — 바뀐 것이 없으면 통로가 아무것도 보내지 않는다
    for (const session of this.sessions.values()) if (session.channel.subscriberCount > 0 && !session.isAlive) session.channel.markDirty();
    this.scheduleBroadcast();
  }

  private readRegistry(): ClaudeSessionRecord[] {
    return this.deps.registry?.() ?? ClaudeSessionRegistry.liveRecords(this.deps.claudeHome);
  }

  /** 이 데몬이 띄운 프로세스는 빼고, 다른 곳에서 그 세션을 쥔 살아 있는 프로세스 */
  liveElsewhere(sessionId: string): { busy: boolean } | undefined {
    const record = this.recordElsewhere(sessionId);
    return record === undefined ? undefined : { busy: record.status === "busy" };
  }

  private recordElsewhere(sessionId: string): ClaudeSessionRecord | undefined {
    const ours = this.ourPids();
    return this.liveRecords.find((candidate) => candidate.sessionID === sessionId && !ours.has(candidate.pid));
  }

  private freshElsewhere(sessionId: string): { busy: boolean } | undefined {
    const record = this.freshRecord(sessionId);
    return record === undefined ? undefined : { busy: record.status === "busy" };
  }

  /** 가져오기 직전의 판정 — 주기를 기다리지 않고 레지스트리를 다시 읽는다 */
  private freshRecord(sessionId: string): ClaudeSessionRecord | undefined {
    this.liveRecords = this.readRegistry();
    return this.recordElsewhere(sessionId);
  }

  /** 이 데몬이 띄운 claude — 세션과 예비, 그리고 30초 안에 닫은 것 */
  private ourPids(): Set<number> {
    const now = Date.now();
    for (const session of this.sessions.values()) if (session.pid !== undefined) this.ownPids.set(session.pid, now);
    if (this.spares.pid !== undefined) this.ownPids.set(this.spares.pid, now);
    for (const [pid, seenAt] of this.ownPids) if (now - seenAt > 30_000) this.ownPids.delete(pid);
    return new Set(this.ownPids.keys());
  }

  // MARK: - 예열

  /** 예열의 바탕 — 예열을 껐거나 claude 가 없으면 undefined. 예비는 홈 폴더에서 뜬다 */
  private async prewarmBasis(): Promise<{ settings: LightSettings; executable: string; environment: Record<string, string>; home: string; signature: string } | undefined> {
    const settings = this.deps.settings.current;
    if (!settings.prewarm) return undefined;
    const executable = await this.claudeExecutable();
    if (executable === undefined) return undefined;
    const environment = await this.host.environment();
    return { settings, executable, environment, home: environment.HOME ?? "/", signature: spareSignature(executable, environment, settings) };
  }

  /** 예비의 기동 값 — 폴더·권한 모드·모델은 claim 때 정하므로 빠진다 */
  private async spareTemplate(): Promise<SpareTemplate | undefined> {
    const basis = await this.prewarmBasis();
    if (basis === undefined) return undefined;
    const { settings, executable, environment, home, signature } = basis;
    const bashTimeouts = terminalBashTimeouts(environment, home, home);
    return {
      options: launchOptions({
        cwd: home, bashTimeouts, thinkingDisplay: thinkingDisplay(home, home), ...settingsPlan(settings),
      }, environment, executable),
      signature,
    };
  }

  /**
   * 그 폴더가 예열 때와 같은 기동 값을 쓸 때만 꺼낸다 — 훅·시스템 프롬프트에 든 Bash 한도와 사고 표시는 예열 때 굳는다.
   * 프로젝트 설정이 이 값을 바꾸는 폴더는 보통으로 띄운다
   */
  private async takeSpare(cwd: string): Promise<ReturnType<SpareSessions["take"]>> {
    const basis = await this.prewarmBasis();
    if (basis === undefined) return undefined;
    const { environment, home, signature } = basis;
    const startup = (folder: string) => JSON.stringify({ bash: terminalBashTimeouts(environment, home, folder), thinking: thinkingDisplay(home, folder) });
    if (startup(cwd) !== startup(home)) return undefined;
    return this.spares.take(signature);
  }

  // MARK: - 모델 목록

  /**
   * 고를 수 있는 모델 — 세션이 뜰 때 받은 목록(그 폴더의 `availableModels` 까지 반영된다, d.ts `prewarm`).
   * 없으면 턴 없는 claude 를 잠깐 띄워 묻는다. 모델을 부르지 않고 설정 파일도 읽지 않는다. 못 받으면 빈 목록이다
   */
  async models(): Promise<ModelOption[]> {
    if (this.modelCache !== undefined && Date.now() - this.modelCache.at < 30 * 60_000) return this.modelCache.models;
    this.modelsLoading ??= this.fetchModels().finally(() => {
      this.modelsLoading = undefined;
    });
    return this.modelsLoading;
  }

  private async fetchModels(): Promise<ModelOption[]> {
    const executable = await this.claudeExecutable();
    if (executable === undefined) return this.modelCache?.models ?? [];
    const never: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    let query: Query | undefined;
    try {
      const environment = await this.host.environment();
      query = this.deps.query({ prompt: never, options: { cwd: environment.HOME ?? "/", env: environment, pathToClaudeCodeExecutable: executable, settingSources: [] } });
      const models = await Promise.race([
        query.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("모델 목록 조회가 15초 안에 끝나지 않았습니다.")), 15_000)),
      ]);
      this.modelCache = { at: Date.now(), models: models.map(modelOption) };
      return this.modelCache.models;
    } catch (error) {
      log("warn", "models failed", { error: errorText(error) });
      return this.modelCache?.models ?? [];
    } finally {
      try {
        query?.close();
      } catch {
        // 이미 닫혔다
      }
    }
  }

  summaries(): SessionSummary[] {
    const result = [...this.sessions.values()].filter((session) => session.origin === "light").map((session) => session.summary());
    const known = new Set(result.map((summary) => summary.id));
    for (const entry of this.historyEntries) {
      if (known.has(entry.sessionID)) continue;
      const open = this.sessions.get(entry.sessionID);
      const elsewhere = this.liveElsewhere(entry.sessionID);
      result.push(open?.summary() ?? {
        id: entry.sessionID, hostId: this.deps.state.hostId, cwd: entry.cwd, project: projectName(entry.cwd), title: entry.title,
        origin: "history", lifecycle: "closed", pendingCount: 0, updatedAt: entry.modifiedAt,
        ...(elsewhere !== undefined ? { liveElsewhere: elsewhere } : {}),
      });
    }
    return result.sort((lhs, rhs) => rhs.updatedAt - lhs.updatedAt);
  }

  /** light 세션이면 그것, 기록 세션이면 읽기 전용으로 만든다(색인에 넣지 않는다) */
  get(sessionId: string): LiveSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      existing.touchedAt = Date.now();
      return existing;
    }
    const entry = this.historyEntries.find((candidate) => candidate.sessionID === sessionId)
      ?? (this.deps.history.transcriptPath(sessionId) !== undefined ? this.historyEntry(sessionId) : undefined);
    if (entry === undefined) return undefined;
    const session = new LiveSession(this.host, { id: sessionId, cwd: entry.cwd, origin: "history", autoTitle: entry.title, updatedAt: entry.modifiedAt });
    this.sessions.set(sessionId, session);
    return session;
  }

  private historyEntry(sessionId: string): HistoryEntry | undefined {
    const titles = this.deps.history.titlesOfSession(sessionId);
    const path = this.deps.history.transcriptPath(sessionId);
    if (titles === undefined || path === undefined) return undefined;
    const stat = statSync(path);
    return {
      sessionID: sessionId, path, cwd: titles.cwd ?? "", title: titles.customTitle ?? titles.aiTitle ?? titles.firstPrompt ?? sessionId,
      modifiedAt: stat.mtimeMs, size: stat.size,
    };
  }

  // MARK: - 프로젝트

  projects(): ProjectCandidate[] {
    const settings = this.deps.settings.current;
    const lastUsed = this.deps.state.folderLastUsed();
    const candidates = new Map<string, ProjectCandidate>();
    const add = (path: string, source: ProjectCandidate["source"], at?: number) => {
      if (path === "" || candidates.has(path)) return;
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return;
      }
      const used = lastUsed[path] ?? at;
      const mode = this.deps.state.folderMode(path);
      candidates.set(path, {
        path, name: projectName(path), source,
        ...(used !== undefined ? { lastUsedAt: used } : {}), ...(mode !== undefined ? { lastPermissionMode: mode } : {}),
      });
    };
    for (const folder of settings.projectFolders) add(folder, "settings");
    for (const session of this.sessions.values()) if (session.origin === "light") add(session.cwd, "history", session.lastActivity);
    for (const entry of this.historyEntries) add(entry.cwd, "history", entry.modifiedAt);
    return [...candidates.values()].sort((lhs, rhs) => {
      if (lhs.source !== rhs.source) return lhs.source === "settings" ? -1 : 1;
      return (rhs.lastUsedAt ?? 0) - (lhs.lastUsedAt ?? 0);
    });
  }

  // MARK: - 새 세션

  async create(input: { cwd: string; prompt: string; attachments: string[]; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }): Promise<LiveSession> {
    // 폰에서 임의 경로를 열지 못한다 — 후보에 있는 폴더만
    if (!this.projects().some((candidate) => candidate.path === input.cwd)) throw new SessionError("등록된 프로젝트 폴더가 아닙니다.", 403);
    // 예비를 고르며 그 폴더의 설정 파일을 동기로 읽는다 — 허용 창에 붙잡힌 폴더면 데몬이 멈추기 전에 여기서 돌려보낸다
    try {
      await this.folders.ensure(input.cwd);
    } catch (error) {
      throw new SessionError(errorText(error), 503);
    }
    const settings = this.deps.settings.current;
    const mode = input.permissionMode ?? this.deps.state.folderMode(input.cwd) ?? settings.defaultPermissionMode;
    const model = input.model ?? settings.defaultModel;
    const effort = input.effort ?? settings.defaultEffort;
    // 예열한 예비가 있으면 그 세션 id 로 — 예열 때 CLI 에 넘긴 id 다
    const spare = await this.takeSpare(input.cwd);
    const id = spare?.id ?? randomUUID();
    const now = Date.now();
    const session = new LiveSession(this.host, {
      id, cwd: input.cwd, origin: "light", fresh: true, permissionMode: mode, updatedAt: now,
      ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(spare !== undefined ? { spare } : {}),
    });
    this.sessions.set(id, session);
    this.deps.state.putSession({
      id, cwd: input.cwd, createdAt: now, updatedAt: now, permissionMode: mode, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
    });
    this.deps.state.rememberFolder(input.cwd, mode);
    await this.makeRoom(id);
    try {
      await session.send(input.prompt, input.attachments, "now");
    } catch (error) {
      log("warn", "first message failed", { session: id, error: errorText(error) });
    }
    this.scheduleBroadcast();
    return session;
  }

  // MARK: - 이어받기

  /**
   * 기록 세션을 light 로 — 터미널에서 살아 있으면 `resume` 은 거절하고 사본(fork)이나 가져오기(takeover)를 고르게 한다.
   * 가져오기는 그 claude pid 하나만 끝낸 뒤 resume 한다. 턴을 도는 중이면 확인을 먼저 받는다
   */
  async resume(sessionId: string, mode: "resume" | "fork" | "takeover", confirmBusy = false): Promise<LiveSession> {
    const session = this.get(sessionId);
    if (session === undefined) throw new SessionError("세션을 찾지 못했습니다.", 404);
    if (mode === "fork") return this.forkFrom(session);
    const record = this.freshRecord(sessionId);
    if (record !== undefined && mode === "resume") {
      throw new SessionError("이 세션은 Mac 의 다른 곳에서 열려 있습니다. 사본으로 이어 가거나 가져오기를 고르십시오.", 409);
    }
    if (record !== undefined) {
      if (record.status === "busy" && !confirmBusy) throw new SessionError("터미널의 세션이 턴을 도는 중입니다. 멈추고 가져올지 확인해 주십시오.", 428);
      log("info", "takeover", { session: sessionId, pid: record.pid, busy: record.status === "busy" });
      const exited = await (this.deps.terminate ?? signalUntilExit)(record.pid, record.status === "busy");
      if (!exited) throw new SessionError("터미널의 claude 를 끝내지 못했습니다.", 500);
      this.refresh();
    }
    // 기다리는 사이 정리돼 빠졌어도 이 객체가 그 세션이다 — 다시 꽂아 닫기·정리의 대상이 되게 한다
    if (this.sessions.get(sessionId) !== session) this.sessions.set(sessionId, session);
    if (session.origin === "history") {
      session.adopt();
      const now = Date.now();
      this.deps.state.putSession({
        id: session.id, cwd: session.cwd, createdAt: now, updatedAt: now, importedFrom: "history",
        ...(session.autoTitle !== undefined ? { autoTitle: session.autoTitle } : {}),
      });
    }
    await session.ensureLoaded();
    await this.makeRoom(session.id);
    await session.start();
    this.scheduleBroadcast();
    return session;
  }

  /** 사본으로 이어 가기 — SDK `forkSession` 이 기록을 새 id 로 복사한다. 원본이 살아 있어도 안전하다(실측) */
  private async forkFrom(source: LiveSession): Promise<LiveSession> {
    const title = `${source.title} (사본)`;
    const fork = this.deps.fork ?? (async (sessionId: string, forkTitle?: string) => (await sdkForkSession(sessionId, forkTitle === undefined ? {} : { title: forkTitle })).sessionId);
    const id = await fork(source.id, title);
    const now = Date.now();
    const session = new LiveSession(this.host, { id, cwd: source.cwd, origin: "light", autoTitle: title, updatedAt: now });
    this.sessions.set(id, session);
    this.deps.state.putSession({ id, cwd: source.cwd, createdAt: now, updatedAt: now, forkedFrom: source.id, autoTitle: title });
    await session.ensureLoaded();
    await this.makeRoom(id);
    await session.start();
    this.scheduleBroadcast();
    return session;
  }

  /** Mac 터미널에서 이어 가도록 — light 쪽 프로세스를 닫고 명령을 준다 */
  async release(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.origin !== "light") throw new SessionError("light 세션이 아닙니다.", 404);
    await session.close("release");
    return `cd ${shellQuote(session.cwd)} && claude --resume ${session.id}`;
  }

  patch(sessionId: string, patch: { title?: string; archived?: boolean }): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.origin !== "light") throw new SessionError("light 세션이 아닙니다.", 404);
    if (patch.title !== undefined) session.customTitle = patch.title.trim() === "" ? undefined : patch.title.trim();
    if (patch.archived !== undefined) session.archived = patch.archived;
    this.deps.state.patchSession(sessionId, { title: session.customTitle, archived: session.archived });
    session.channel.markDirty();
    this.scheduleBroadcast();
  }

  // MARK: - 수명

  private limit(): number {
    return this.deps.settings.current.maxConcurrentSessions ?? defaultSessionLimit(this.deps.totalMemory ?? totalmem());
  }

  /** 상한을 넘으면 가장 오래 쉰 세션부터 닫는다 — 일하는 세션은 닫지 않는다 */
  private async makeRoom(except: string): Promise<void> {
    const alive = [...this.sessions.values()].filter((session) => session.isAlive && session.id !== except);
    let excess = alive.length + 1 - this.limit();
    if (excess <= 0) return;
    const idle = alive.filter((session) => !session.isBusy).sort((lhs, rhs) => lhs.lastActivity - rhs.lastActivity);
    for (const session of idle) {
      if (excess <= 0) break;
      await session.close("limit");
      excess -= 1;
    }
    if (excess > 0) log("warn", "session limit exceeded", { limit: this.limit() });
  }

  private async sweepIdle(): Promise<void> {
    const limitMs = this.deps.settings.current.idleCloseMinutes * 60_000;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.isAlive || session.isBusy || now - session.lastActivity < limitMs) continue;
      if (session.channel.subscriberCount > 0 && now - session.lastActivity < limitMs * 2) continue;
      await session.close("idle");
    }
    // 아무도 보지 않는 기록 세션은 버린다 — 다시 열면 기록에서 읽는다
    for (const [id, session] of this.sessions) {
      if (session.origin === "history" && !session.isAlive && !session.isLoading && session.channel.subscriberCount === 0 && now - session.touchedAt > 60_000) {
        session.dispose();
        this.sessions.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.sleepWatch.stop();
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
    this.spares.shutdown();
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    if (this.broadcastTimer !== undefined) clearTimeout(this.broadcastTimer);
    await Promise.all([...this.sessions.values()].map((session) => session.close("shutdown").catch(() => undefined)));
    this.deps.state.flush();
  }

  counts(): { running: number; alive: number; pending: number } {
    let running = 0;
    let alive = 0;
    let pending = 0;
    for (const session of this.sessions.values()) {
      if (session.isAlive) alive += 1;
      if (session.isAlive && session.model.status.isTurnActive) running += 1;
      pending += session.model.pending.length;
    }
    return { running, alive, pending };
  }

  // MARK: - claude 실행 파일

  async claudeExecutable(): Promise<string | undefined> {
    const configured = this.deps.settings.current.claudePath;
    const environment = await this.deps.shell.environment();
    const key = `${configured ?? ""}|${environment.PATH ?? ""}`;
    if (this.claudePathCache?.key === key && this.claudePathCache.path !== undefined && existsSync(this.claudePathCache.path)) return this.claudePathCache.path;
    const path = resolveExecutable(configured ?? "claude", environment.PATH);
    this.claudePathCache = { key, path };
    return path;
  }

  // MARK: - 바뀜·알림

  private sessionChanged(session: LiveSession): void {
    if (session.pid !== undefined) this.ownPids.set(session.pid, Date.now());
    if (session.origin === "light" && this.deps.state.session(session.id) !== undefined) {
      const lastMessage = lastMessageLine(session.model);
      const status = session.model.status;
      this.deps.state.patchSession(session.id, {
        updatedAt: session.lastActivity,
        ...(lastMessage !== undefined ? { lastMessage } : {}),
        ...(session.autoTitle !== undefined ? { autoTitle: session.autoTitle } : {}),
        ...(status.model !== undefined ? { model: status.model } : {}),
        ...(status.permissionMode !== undefined ? { permissionMode: status.permissionMode } : {}),
        // 기본값으로 돌린 선택은 키를 지운다(undefined 는 저장할 때 빠진다)
        effort: session.choices.effort, fastMode: session.choices.fastMode,
        // 끝나는 중에 닫혀 내려간 턴은 끊긴 턴이다 — 표시를 남겨 다음 기동이 이어 간다
        ...(this.stopping ? {} : { turnActiveAt: status.isTurnActive && session.isAlive ? status.turnStartedAt ?? Date.now() : undefined }),
      });
    }
    this.scheduleBroadcast();
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== undefined) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      const sessions = this.summaries();
      const encoded = JSON.stringify(sessions);
      if (encoded === this.lastBroadcast) return;
      this.lastBroadcast = encoded;
      for (const listener of this.listeners) listener(sessions);
    }, 250);
  }

  private attention(session: LiveSession, event: AttentionEvent): void {
    const project = projectName(session.cwd);
    switch (event.kind) {
      case "pending": {
        this.deps.notifier.cancel(session.id);
        void this.deps.notifier.notify({
          kind: pendingCategory(event.pending), sessionId: session.id, project, body: pendingBody(event.pending), requestId: event.pending.requestID,
        });
        return;
      }
      case "turnDone":
        this.deps.notifier.turnDone({
          sessionId: session.id, project,
          summary: () => wrapUpText(session.model.status.wrapUp) ?? session.model.status.turnSummary,
          fallback: () => lastMessageLine(session.model) ?? "응답이 끝났습니다.",
          stillIdle: () => !session.model.status.isTurnActive && session.model.pending.length === 0,
        });
        return;
      case "error":
        void this.deps.notifier.notify({ kind: "error", sessionId: session.id, project, body: firstLine(event.message) || "세션에 오류가 났습니다." });
        return;
    }
  }
}

/** claude 의 모델 줄 → 화면의 선택지. 노력도 단계가 없으면 노력도를 받지 않는 모델이다 */
function modelOption(info: ModelInfo): ModelOption {
  const efforts = info.supportsEffort === false ? [] : (info.supportedEffortLevels ?? []).filter((level) => (EFFORT_LEVELS as readonly string[]).includes(level));
  return {
    value: info.value, label: info.displayName,
    ...(info.resolvedModel !== undefined ? { resolvedModel: info.resolvedModel } : {}),
    ...(info.description !== "" ? { description: info.description } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(info.supportsFastMode === true ? { fastMode: true } : {}),
  };
}

/** 예비를 만든 입력의 지문 — 실행 파일·env·인증이 같아야 그 예비를 쓴다 */
function spareSignature(executable: string, environment: Readonly<Record<string, string>>, settings: LightSettings): string {
  const env = Object.entries(environment).sort(([lhs], [rhs]) => lhs.localeCompare(rhs)).map(([key, value]) => `${key}=${value}`).join("\0");
  return JSON.stringify({ executable, authMode: settings.authMode, env: Bun.hash(env).toString(36) });
}

/** 「다음 단계」 상자의 알림 본문 — 요약, 질문이 있으면 그 뒤에 */
function wrapUpText(wrapUp: TurnWrapUp | undefined): string | undefined {
  if (wrapUp === undefined) return undefined;
  return wrapUp.ask === undefined ? wrapUp.recap : `${wrapUp.recap} ${wrapUp.ask}`;
}

function pendingBody(pending: PendingInteraction): string {
  switch (pending.kind) {
    case "permission":
      return `${pending.request.displayName ?? pending.request.toolName}: ${pending.summary}`;
    case "question":
      return pending.questions[0]?.question ?? "질문이 있습니다.";
    case "planApproval":
      return `계획을 승인해 주십시오 — ${firstLine(pending.plan, 120)}`;
    case "elicitation":
      return `${pending.serverName}: ${firstLine(pending.message, 120)}`;
    case "dialog":
      return pending.title;
  }
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
