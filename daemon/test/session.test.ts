import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { ClaudeHistory } from "../src/claude/history.ts";
import { FolderAccess } from "../src/folder-access.ts";
import { ShellEnvironment } from "../src/claude/shell-environment.ts";
import { configureLog } from "../src/log.ts";
import { Notifier } from "../src/push/notifier.ts";
import { generateVapidKeys } from "../src/push/web-push.ts";
import { SessionManager } from "../src/session/manager.ts";
import { DeviceStore, SettingsStore, StateStore } from "../src/stores.ts";
import { Uploads } from "../src/uploads.ts";

interface FakeLog {
  started: Options[];
  closed: number;
  asked: unknown[];
  /** 제어 요청 — `applyFlagSettings`·`stopTask`·`setModel` */
  controls: unknown[];
  /** claude 가 받은 사람 줄 그대로 */
  messages: SDKUserMessage[];
  /** `backgroundTasks` 가 돌려줄 값 */
  backgroundable: boolean;
}

function newLog(): FakeLog {
  return { started: [], closed: 0, asked: [], controls: [], messages: [], backgroundable: true };
}

/**
 * 가짜 `query()` — 사람 턴마다 init·답·result 를 낸다. 글에 "ask:" 가 있으면 먼저 canUseTool 로 Bash 권한을 묻는다.
 * 글에 "bg:" 가 있으면 백그라운드 작업 하나를 띄운 채 턴을 끝낸다. 적용값은 플래그 층에 얹은 노력도를 돌려준다
 */
function fakeQuery(log: FakeLog) {
  return ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    log.started.push(options!);
    let effort = (options?.settings as { effortLevel?: string } | undefined)?.effortLevel ?? "medium";
    const outbox: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    /** 지금 묻고 있는 권한 — 중단하면 CLI 처럼 그 요청을 거둔다 */
    let asking: AbortController | undefined;
    const emit = (message: unknown) => {
      outbox.push(message);
      wake?.();
    };
    void (async () => {
      let turn = 0;
      for await (const message of prompt) {
        log.messages.push(message);
        // 기록에만 붙이는 줄 — 실측처럼 init 과 모델 턴 없는 result 만 낸다
        if ((message as { shouldQuery?: boolean }).shouldQuery === false) {
          emit({ type: "system", subtype: "init", session_id: "x", model: "claude-haiku-5-5", permissionMode: "default", slash_commands: [] });
          emit({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 1, session_id: "x" });
          continue;
        }
        turn += 1;
        const content = (message.message as { content: { type: string; text?: string }[] }).content;
        const text = content.find((block) => block.type === "text")?.text ?? "";
        emit({ type: "system", subtype: "init", session_id: options!.sessionId ?? options!.resume, model: "claude-haiku-5-5", permissionMode: "default", slash_commands: [] });
        if (text.includes("ask:")) {
          asking = new AbortController();
          const decision = await options!.canUseTool!("Bash", { command: "ls" }, {
            signal: asking.signal, toolUseID: `tool-${turn}`, requestId: `req-${turn}`, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
          } as never);
          log.asked.push(decision);
        }
        if (text.includes("bg:")) emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: `task-${turn}`, task_type: "local_bash", description: "sleep" }] });
        emit({ type: "assistant", message: { id: `m${turn}`, role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] }, parent_tool_use_id: null });
        emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0.001 * turn, session_id: "x" });
      }
      ended = true;
      wake?.();
    })();
    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        for (;;) {
          if (outbox.length > 0) return { done: false, value: outbox.shift() };
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    };
    return {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        asking?.abort();
      },
      setPermissionMode: async () => undefined,
      setModel: async (model?: string) => {
        log.controls.push({ setModel: model });
      },
      applyFlagSettings: async (settings: { effortLevel?: string | null }) => {
        log.controls.push({ applyFlagSettings: settings });
        if (settings.effortLevel !== undefined) effort = settings.effortLevel ?? "medium";
      },
      stopTask: async (taskId: string) => {
        log.controls.push({ stopTask: taskId });
        emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      },
      initializationResult: async () => ({ models: [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] }] }),
      getSettings: async () => ({ applied: { model: "claude-haiku-5-5", effort } }),
      getContextUsage: async () => ({ totalTokens: 12_000, maxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true }),
      askSideQuestion: async (question: string, extra: unknown) => {
        log.controls.push({ askSideQuestion: question, extra });
        return { response: `곁가지 답: ${question}`, synthetic: false };
      },
      backgroundTasks: async () => {
        log.controls.push({ backgroundTasks: true });
        return log.backgroundable;
      },
      generateSessionTitle: async (description: string, extra: unknown) => {
        log.controls.push({ generateSessionTitle: description, extra });
        return "지은 제목";
      },
      getTaskOutput: async (taskId: string) => ({ output: `out of ${taskId}`, total_bytes: 10, truncated: false }),
      rewindFiles: async (userMessageId: string, extra: { dryRun?: boolean }) => {
        log.controls.push({ rewindFiles: userMessageId, dryRun: extra?.dryRun === true });
        return { canRewind: true, filesChanged: ["/p/a.ts"], insertions: 3, deletions: 1 };
      },
      close: () => {
        log.closed += 1;
        ended = true;
        wake?.();
      },
    } as unknown as Query;
  };
}

/** 가짜 `prewarm` — claim 을 받아들이면 가짜 query 로 돌고, 거절하면 첫 입력을 꺼내 간 뒤 not_claimed 로 끝난다(d.ts) */
function fakePrewarm(log: FakeLog, outcome: "accept" | "refuse", prewarmed: Options[]) {
  return async ({ options }: { options: Options }) => {
    prewarmed.push(options);
    let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
    const claimed = new Promise<{ cwd: string; sessionId: string; sdkMcpSettled: boolean }>((resolve, reject) => {
      settle = { resolve: resolve as (value: unknown) => void, reject };
    });
    claimed.catch(() => undefined);
    return {
      claim: ({ prompt, options: claim }: { prompt: AsyncIterable<SDKUserMessage>; options: { cwd: string } }) => {
        log.controls.push({ claim });
        if (outcome === "accept") {
          settle!.resolve({ cwd: claim.cwd, sessionId: options.sessionId!, sdkMcpSettled: true });
          return fakeQuery({ ...newLog(), asked: log.asked, controls: log.controls, messages: log.messages })({ prompt, options: { ...options, ...claim } });
        }
        const iterator = prompt[Symbol.asyncIterator]();
        let done = false;
        void iterator.next().then(() => settle!.reject(new Error("not_a_spare: refused")));
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await claimed.catch(() => undefined);
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: { type: "result", subtype: "error_during_execution", is_error: true, result: "not_claimed", num_turns: 0 } };
            },
          }),
          interrupt: async () => undefined, close: () => undefined,
        } as unknown as Query;
      },
      claimed,
      close: () => undefined,
      exited: new Promise<void>(() => {}),
    } as never;
  };
}

async function setup(overrides: { maxConcurrentSessions?: number; defaultEffort?: string; prewarm?: "accept" | "refuse"; autoContinue?: boolean; folderAccess?: FolderAccess } = {}) {
  configureLog(mkdtempSync(join(tmpdir(), "light-logs-")), { quiet: true });
  const data = mkdtempSync(join(tmpdir(), "light-data-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "light-claude-"));
  const project = mkdtempSync(join(tmpdir(), "light-project-"));
  mkdirSync(join(claudeHome, "projects"));
  const settings = new SettingsStore(join(data, "settings.json"));
  const { prewarm, folderAccess, ...settingOverrides } = overrides;
  settings.update({ projectFolders: [project], claudePath: "/bin/echo", prewarm: prewarm !== undefined, ...settingOverrides });
  const devices = new DeviceStore(join(data, "devices.json"));
  const log = newLog();
  const prewarmed: Options[] = [];
  const state = new StateStore(join(data, "state.json"));
  const uploads = new Uploads(join(data, "uploads"));
  const manager = new SessionManager({
    settings, state, history: new ClaudeHistory(claudeHome), uploads,
    notifier: new Notifier({ devices, settings: () => settings.current, vapid: await generateVapidKeys(), pushLog: join(data, "push.jsonl") }),
    shell: new ShellEnvironment(data, async () => undefined), query: fakeQuery(log), claudeHome, registry: () => [],
    ...(prewarm !== undefined ? { prewarm: fakePrewarm(log, prewarm, prewarmed) as never, prewarmDelayMs: 0 } : {}),
    ...(folderAccess !== undefined ? { folderAccess } : {}),
  });
  return { manager, project, log, prewarmed, state, claudeHome, data, settings, uploads };
}

async function until(check: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("기다린 상태가 오지 않았습니다");
    await Bun.sleep(5);
  }
}

describe("세션 관리(가짜 query)", () => {
  test("새 세션은 데몬이 정한 id 로 띄우고 첫 턴이 끝나면 유휴다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    expect(log.started[0]?.sessionId).toBe(session.id);
    expect(log.started[0]?.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(session.model.items.map((item) => item.content.kind)).toEqual(["user", "assistant", "notice"]);
    await manager.shutdown();
  });

  test("등록되지 않은 폴더는 열지 않는다", async () => {
    const { manager } = await setup();
    await expect(manager.create({ cwd: "/etc", prompt: "x", attachments: [] })).rejects.toThrow("등록된 프로젝트 폴더가 아닙니다");
    await manager.shutdown();
  });

  test("허용 창에 붙잡힌 폴더는 새 세션을 띄우지 않고 까닭을 돌려준다", async () => {
    const folderAccess = new FolderAccess({ timeoutMs: 20, probe: () => new Promise(() => {}) });
    const { manager, project, log } = await setup({ folderAccess });
    await expect(manager.create({ cwd: project, prompt: "안녕", attachments: [] })).rejects.toThrow("붙잡고 있습니다");
    expect(log.started).toHaveLength(0);
    expect(manager.sessions.size).toBe(0);
    await manager.shutdown();
  });

  test("다시 띄울 때 폴더가 붙잡히면 그 세션만 실패하고 까닭을 대화에 남긴다", async () => {
    // 만들 때의 확인은 지나가고 띄울 때의 확인이 붙잡힌다
    let probes = 0;
    const folderAccess = new FolderAccess({ timeoutMs: 20, probe: () => (++probes === 1 ? Promise.resolve() : new Promise(() => {})) });
    const { manager, project, log } = await setup({ folderAccess });
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    expect(log.started).toHaveLength(0);
    expect(JSON.stringify(session.model.items)).toContain("붙잡고 있습니다");
    await manager.shutdown();
  });

  test("권한 요청은 답이 올 때까지 기다리고 먼저 온 답 하나만 받는다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "ask: 목록", attachments: [] });
    await until(() => session.lifecycle === "waitingPermission");
    await Bun.sleep(50);
    // 기한 없이 기다린다
    expect(session.lifecycle).toBe("waitingPermission");
    const requestId = session.model.pending[0]!.requestID;
    expect(session.respond(requestId, { kind: "approvePlan" })).toBe("invalid");
    expect(session.respond(requestId, { kind: "allowSession" })).toBe("ok");
    expect(session.respond(requestId, { kind: "deny" })).toBe("handled");
    await until(() => session.lifecycle === "idle");
    expect(log.asked).toEqual([{ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }] }]);
    await manager.shutdown();
  });

  test("턴 도중에 보낸 글은 쌓였다가 하나로 합쳐 다음 턴이 된다", async () => {
    const { manager, project } = await setup();
    const session = await manager.create({ cwd: project, prompt: "ask: 첫 턴", attachments: [] });
    await until(() => session.lifecycle === "waitingPermission");
    expect(await session.send("둘째", [], "queue")).toEqual({ queued: true });
    expect(await session.send("셋째", [], "queue")).toEqual({ queued: true });
    session.respond(session.model.pending[0]!.requestID, { kind: "allow" });
    await until(() => session.model.items.filter((item) => item.content.kind === "user").length === 2 && session.lifecycle === "idle");
    const users = session.model.items.flatMap((item) => (item.content.kind === "user" ? [item.content.text] : []));
    expect(users).toEqual(["ask: 첫 턴", "둘째\n\n셋째"]);
    expect(session.model.queued).toEqual([]);
    await manager.shutdown();
  });

  test("닫히는 중에 보낸 메시지는 잃지 않고 다시 열어 보낸다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "첫째", attachments: [] });
    await until(() => session.lifecycle === "idle");
    const closing = session.close("idle");
    const sent = session.send("닫히는 중에", [], "queue");
    await Promise.all([closing, sent]);
    await until(() => session.model.items.some((item) => item.content.kind === "assistant" && item.content.text === "echo: 닫히는 중에"));
    expect(log.started.length).toBe(2);
    await manager.shutdown();
  });

  test("예열한 예비를 claim 해 그 세션 id 로 돌고 권한 콜백이 세션으로 이어진다", async () => {
    const { manager, project, log, prewarmed } = await setup({ prewarm: "accept" });
    manager.startTimers();
    await until(() => prewarmed.length === 1);
    await Bun.sleep(20);
    const session = await manager.create({ cwd: project, prompt: "ask: 예열", attachments: [] });
    expect(session.id).toBe(prewarmed[0]!.sessionId!);
    expect(prewarmed[0]!.cwd).not.toBe(project);
    await until(() => session.lifecycle === "waitingPermission");
    session.respond(session.model.pending[0]!.requestID, { kind: "allow" });
    await until(() => session.lifecycle === "idle");
    expect(log.started.length).toBe(0);
    expect(log.asked).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
    // 하나를 꺼냈으니 다음 예비를 예열한다
    await until(() => prewarmed.length === 2);
    await manager.shutdown();
  });

  test("claim 이 거절되면 꺼내 간 입력을 되감아 보통으로 띄운다", async () => {
    const { manager, project, log, prewarmed } = await setup({ prewarm: "refuse" });
    manager.startTimers();
    await until(() => prewarmed.length === 1);
    await Bun.sleep(20);
    const session = await manager.create({ cwd: project, prompt: "되감기", attachments: [] });
    await until(() => session.model.items.some((item) => item.content.kind === "assistant" && item.content.text === "echo: 되감기"));
    expect(log.started.length).toBe(1);
    expect(log.started[0]!.sessionId).toBe(session.id);
    expect(session.model.items.some((item) => item.content.kind === "notice" && item.content.notice.kind === "error")).toBe(false);
    await manager.shutdown();
  });

  test("동시 상한을 넘으면 가장 오래 쉰 세션부터 닫는다", async () => {
    const { manager, project, log } = await setup({ maxConcurrentSessions: 2 });
    const first = await manager.create({ cwd: project, prompt: "1", attachments: [] });
    await until(() => first.lifecycle === "idle");
    const second = await manager.create({ cwd: project, prompt: "2", attachments: [] });
    await until(() => second.lifecycle === "idle");
    const third = await manager.create({ cwd: project, prompt: "3", attachments: [] });
    await until(() => third.lifecycle === "idle");
    expect([first.isAlive, second.isAlive, third.isAlive]).toEqual([false, true, true]);
    expect(first.lifecycle).toBe("closed");
    expect(log.started.length).toBe(3);
    await manager.shutdown();
    expect([second.isAlive, third.isAlive]).toEqual([false, false]);
  });
});

describe("노력도·빠른 모드·작업 멈춤(가짜 query)", () => {
  test("노력도는 플래그 층으로 띄우고, 바꾸면 플래그 층을 고친 뒤 적용값을 다시 읽고, 기본값으로 돌리면 저장에서 지운다", async () => {
    const { manager, project, log, state } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [], effort: "high" });
    await until(() => session.lifecycle === "idle" && session.view().effort === "high");
    expect(log.started[0]?.settings).toMatchObject({ effortLevel: "high" });
    expect(state.session(session.id)?.effort).toBe("high");
    await session.setEffort("low");
    expect(log.controls).toContainEqual({ applyFlagSettings: { effortLevel: "low" } });
    expect(session.view().effort).toBe("low");
    // 모델 기본값으로 — 적용값은 claude 가 알린 값(가짜는 medium)
    await session.setEffort(null);
    expect(log.controls).toContainEqual({ applyFlagSettings: { effortLevel: null } });
    expect(session.view().effort).toBe("medium");
    await until(() => state.session(session.id)?.effort === undefined);
    await manager.shutdown();
  });

  test("예열한 예비는 노력도·빠른 모드를 claim 의 플래그 층으로 받는다", async () => {
    const { manager, project, log, prewarmed } = await setup({ prewarm: "accept" });
    manager.startTimers();
    await until(() => prewarmed.length === 1);
    await Bun.sleep(20);
    const session = await manager.create({ cwd: project, prompt: "예열", attachments: [], effort: "max" });
    await until(() => session.lifecycle === "idle");
    expect(prewarmed[0]!.settings).toBeUndefined();
    expect(log.controls).toContainEqual({ claim: expect.objectContaining({ settings: { effortLevel: "max" } }) });
    await until(() => session.view().effort === "max");
    await manager.shutdown();
  });

  test("기본 노력도는 Mac 설정을 따른다", async () => {
    const { manager, project, log } = await setup({ defaultEffort: "xhigh" });
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    expect(log.started[0]?.settings).toMatchObject({ effortLevel: "xhigh" });
    await manager.shutdown();
  });

  test("중단은 턴만 끊고 백그라운드 작업은 stopTask 로 하나씩 멈춘다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "bg: 잠자기", attachments: [] });
    await until(() => session.lifecycle === "idle");
    expect(session.view().backgroundTasks).toEqual([{ id: "task-1", type: "local_bash", description: "sleep" }]);
    // 작업이 살아 있으면 유휴 정리가 닫지 않는다
    expect(session.isBusy).toBe(true);
    await session.stopTask("없는 작업");
    expect(log.controls.filter((control) => Object.hasOwn(control as object, "stopTask"))).toEqual([]);
    await session.stopTask("task-1");
    expect(log.controls).toContainEqual({ stopTask: "task-1" });
    await until(() => session.view().backgroundTasks.length === 0);
    expect(session.isBusy).toBe(false);
    await manager.shutdown();
  });

  test("빠른 모드는 플래그 층에 얹고 다시 띄울 때도 싣는다. 못 켜는 까닭을 알면 얹지 않고 알린다", async () => {
    const { manager, project, log, state } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    await session.setFastMode(true);
    expect(log.controls).toContainEqual({ applyFlagSettings: { fastMode: true } });
    expect(session.view().fastMode.requested).toBe(true);
    await until(() => state.session(session.id)?.fastMode === true);
    await session.close("idle");
    await session.send("다시", [], "queue");
    await until(() => log.started.length === 2);
    expect(log.started[1]?.settings).toMatchObject({ fastMode: true });
    // claude 가 계정에서 막혔다고 알렸다
    session.model.status.fastMode = { state: "off", disabledReason: "extra_usage_disabled" };
    await session.setFastMode(false);
    const before = log.controls.length;
    await session.setFastMode(true);
    expect(log.controls.length).toBe(before);
    expect(session.model.items.at(-1)?.content).toEqual({ kind: "notice", notice: { kind: "info", text: "계정의 추가 사용량이 꺼져 있어 빠른 모드를 쓰지 못합니다." } });
    await manager.shutdown();
  });

  test("세션이 뜨면 모델 목록·컨텍스트 창을 받아 둔다", async () => {
    const { manager, project } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle" && session.view().contextWindow !== undefined);
    expect(session.view().contextWindow).toEqual({ max: 200_000, autoCompactAt: 167_000 });
    expect(await manager.models()).toEqual([{ value: "sonnet", label: "Sonnet", efforts: ["low", "high", "max"] }]);
    await manager.shutdown();
  });

  test("모델 목록의 default 줄은 기본 모델로 돌린다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [], model: "sonnet" });
    await until(() => session.lifecycle === "idle");
    await session.setModel("default");
    expect(log.controls).toContainEqual({ setModel: undefined });
    // 실제 모델은 적용값이 채운다
    expect(session.view().model).toBe("claude-haiku-5-5");
    await manager.shutdown();
  });
});

/** 사람 줄의 글 블록 */
function textOf(message: SDKUserMessage | undefined): string {
  const content = (message?.message as { content: { type: string; text?: string }[] } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

describe("폰 명령·제목·이력(가짜 query)", () => {
  test("/btw 는 대화에 넣지 않고 곁가지 질문으로 묻고 답을 안내 줄로 남긴다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    expect(await session.send("/btw 뭐였지?", [], "queue")).toEqual({ queued: false });
    await until(() => session.model.items.some((item) => item.content.kind === "notice" && item.content.notice.kind === "side"));
    expect(log.controls).toContainEqual({ askSideQuestion: "뭐였지?", extra: { history: [] } });
    expect(session.model.items.at(-1)?.content).toEqual({ kind: "notice", notice: { kind: "side", text: "뭐였지?\n\n곁가지 답: 뭐였지?" } });
    // claude 에는 사람 턴으로 가지 않았다
    expect(log.messages.map(textOf)).toEqual(["안녕"]);
    // 이어 물으면 앞 질문과 답을 함께 보낸다
    await session.send("/btw 또?", [], "queue");
    await until(() => log.controls.some((control) => (control as { askSideQuestion?: string }).askSideQuestion === "또?"));
    expect(log.controls).toContainEqual({ askSideQuestion: "또?", extra: { history: [{ question: "뭐였지?", response: "곁가지 답: 뭐였지?" }] } });
    await manager.shutdown();
  });

  test("/fork 는 fork 에이전트를 띄우라는 글로 보내고 화면에는 친 그대로 보인다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "/fork 파일 수 세기", attachments: [] });
    await until(() => session.lifecycle === "idle");
    expect(textOf(log.messages[0])).toContain("subagent_type \"fork\"");
    expect(textOf(log.messages[0])).toEndWith("Directive: 파일 수 세기");
    expect(session.model.items[0]?.content).toEqual({ kind: "user", text: "/fork 파일 수 세기" });
    await manager.shutdown();
  });

  test("/background 는 도는 도구를 넘기고, 넘길 것이 없으면 그렇게 알린다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "ask: 기다림", attachments: [] });
    await until(() => session.lifecycle === "waitingPermission");
    await session.send("/background", [], "queue");
    expect(log.controls).toContainEqual({ backgroundTasks: true });
    log.backgroundable = false;
    await session.background();
    expect(session.model.items.at(-1)?.content).toMatchObject({ kind: "notice", notice: { kind: "info", text: expect.stringContaining("아직 없습니다") } });
    session.respond(session.model.pending[0]!.requestID, { kind: "allow" });
    await until(() => session.lifecycle === "idle");
    await manager.shutdown();
  });

  test("! 셸 줄은 그 폴더에서 돌리고 입력·출력을 기록에만 붙인다 — 빈 init·result 는 턴을 열지 않는다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    const statsBefore = session.model.items.filter((item) => item.content.kind === "notice" && item.content.notice.kind === "turnStats").length;
    await session.send("! printf '<a>&b' && pwd", [], "queue");
    await until(() => log.messages.length === 3 && session.model.items.some((item) => item.content.kind === "notice" && item.content.notice.kind === "shell"));
    await Bun.sleep(30);
    expect(log.messages.slice(1).map((message) => (message as { shouldQuery?: boolean }).shouldQuery)).toEqual([false, false]);
    expect(textOf(log.messages[1])).toBe("<bash-input>printf '<a>&b' && pwd</bash-input>");
    expect(textOf(log.messages[2])).toContain("&lt;a&gt;&amp;b");
    const shell = session.model.items.find((item) => item.content.kind === "notice" && item.content.notice.kind === "shell")?.content;
    expect(shell).toMatchObject({ notice: { text: expect.stringContaining(`<a>&b${realpath(project)}`) } });
    expect(session.model.items.some((item) => item.content.kind === "user" && item.content.text === "! printf '<a>&b' && pwd")).toBe(true);
    expect(session.model.status.isTurnActive).toBe(false);
    expect(session.model.items.filter((item) => item.content.kind === "notice" && item.content.notice.kind === "turnStats").length).toBe(statsBefore);
    await manager.shutdown();
  });

  test("새 세션은 첫 메시지로 제목을 짓고, 보낸 글은 터미널 입력 이력에 남긴다", async () => {
    const { manager, project, log, claudeHome } = await setup();
    const session = await manager.create({ cwd: project, prompt: "로그인 버그 고치자", attachments: [] });
    await until(() => session.title === "지은 제목");
    expect(log.controls).toContainEqual({ generateSessionTitle: "로그인 버그 고치자", extra: { persist: true } });
    await session.send("! ls", [], "queue");
    const lines = readFileSync(join(claudeHome, "history.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.display)).toEqual(["로그인 버그 고치자", "! ls"]);
    expect(lines[0]).toMatchObject({ pastedContents: {}, project, sessionId: session.id });
    await manager.shutdown();
  });

  test("턴 도구·파일 체크포인트를 싣고, 프롬프트는 기록하지 않는다", async () => {
    const { manager, project, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    const options = log.started[0]!;
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["turn"]);
    expect(options.enableFileCheckpointing).toBe(true);
    expect(options.env?.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe("1");
    expect(options.systemPrompt).toMatchObject({ snapshot: false, append: expect.stringContaining("mcp__turn__wrap_up") });
    // Bash 한도·턴 도구 자동 허용
    expect(options.hooks?.PreToolUse?.length).toBe(2);
    await manager.shutdown();
  });

  test("작은 PDF 는 document 블록으로 싣고 파일 칩으로 보인다", async () => {
    const { manager, project, log, uploads } = await setup();
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n");
    const info = await uploads.save(pdf.buffer as ArrayBuffer, { name: "명세.pdf", kind: "file", mediaType: "application/pdf" });
    const session = await manager.create({ cwd: project, prompt: "읽어 줘", attachments: [info.id] });
    await until(() => session.lifecycle === "idle");
    const content = (log.messages[0]!.message as { content: { type: string; title?: string }[] }).content;
    expect(content.map((block) => block.type)).toEqual(["document", "text"]);
    expect(content[0]?.title).toBe("명세.pdf");
    expect(session.model.items[0]).toMatchObject({ content: { kind: "user", text: "읽어 줘" }, files: ["명세.pdf"] });
    await manager.shutdown();
  });
});

describe("자동 이어 가기·되감기·정리(가짜 query)", () => {
  test("턴 도중에 데몬이 끝나면 표시가 남고, 다음 기동이 이어 가라는 턴을 보낸다", async () => {
    const first = await setup();
    const session = await first.manager.create({ cwd: first.project, prompt: "ask: 긴 일", attachments: [] });
    await until(() => session.lifecycle === "waitingPermission");
    await until(() => first.state.session(session.id)?.turnActiveAt !== undefined);
    await first.manager.shutdown();
    expect(first.state.session(session.id)?.turnActiveAt).toBeNumber();
    // 같은 데이터 폴더로 다시 띄운다
    const log = newLog();
    const state = new StateStore(join(first.data, "state.json"));
    const manager = new SessionManager({
      settings: first.settings, state, history: new ClaudeHistory(first.claudeHome), uploads: first.uploads,
      notifier: new Notifier({ devices: new DeviceStore(join(first.data, "devices.json")), settings: () => first.settings.current, vapid: await generateVapidKeys(), pushLog: join(first.data, "push.jsonl") }),
      shell: new ShellEnvironment(first.data, async () => undefined), query: fakeQuery(log), claudeHome: first.claudeHome, registry: () => [],
    });
    expect(await manager.resumeInterrupted()).toEqual([session.id]);
    await until(() => log.messages.length === 1);
    expect(textOf(log.messages[0])).toBe("The app was quit while you were working. Please continue from where you left off.");
    expect((log.messages[0] as { origin?: unknown }).origin).toEqual({ kind: "auto-continuation" });
    const revived = manager.sessions.get(session.id)!;
    await until(() => revived.lifecycle === "idle");
    expect(revived.model.items.some((item) => item.content.kind === "notice" && item.content.notice.text.includes("멈춘 작업을 이어 갑니다"))).toBe(true);
    await until(() => state.session(session.id)?.turnActiveAt === undefined);
    await manager.shutdown();
  });

  test("하루 넘은 끊긴 턴은 이어 가지 않고 표시만 지운다", async () => {
    const { manager, project, state, log } = await setup();
    const session = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => session.lifecycle === "idle");
    await session.close("idle");
    state.patchSession(session.id, { turnActiveAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    expect(await manager.resumeInterrupted()).toEqual([]);
    expect(state.session(session.id)?.turnActiveAt).toBeUndefined();
    expect(log.messages.length).toBe(1);
    await manager.shutdown();
  });

  test("되감기는 코드를 떠 있는 프로세스로 돌리고, 대화는 닫았다가 그 앞 assistant 까지만 이어 연다", async () => {
    const { manager, project, log, claudeHome } = await setup();
    const session = await manager.create({ cwd: project, prompt: "첫째", attachments: [] });
    await until(() => session.lifecycle === "idle");
    // 기록 — 첫째(u1) → 답(a1) → 둘째(u2) → 답(a2)
    const slug = join(claudeHome, "projects", "p");
    mkdirSync(slug, { recursive: true });
    const line = (entry: Record<string, unknown>) => JSON.stringify({ sessionId: session.id, cwd: project, timestamp: "2026-10-22T10:00:00.000Z", ...entry });
    writeFileSync(join(slug, `${session.id}.jsonl`), [
      line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "첫째" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "echo: 첫째" }] } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "text", text: "@\"/up/x.txt\"\n둘째" }] } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "echo: 둘째" }] } }),
    ].join("\n"));
    const points = await session.rewindPoints();
    expect(points.map((point) => [point.id, point.text, point.resumeAt])).toEqual([["u2", "둘째", "a1"], ["u1", "첫째", undefined]]);
    expect((await session.rewind("u2", "both", true)).preview).toEqual({ canRewind: true, filesChanged: ["/p/a.ts"], insertions: 3, deletions: 1 });
    await expect(session.rewind("u1", "conversation", false)).rejects.toThrow("첫 메시지로는");
    const result = await session.rewind("u2", "both", false);
    expect(result).toEqual({ draft: "둘째" });
    expect(log.controls).toContainEqual({ rewindFiles: "u2", dryRun: false });
    expect(session.isAlive).toBe(false);
    expect(session.model.items.filter((item) => item.content.kind === "user").map((item) => (item.content as { text: string }).text)).toEqual(["첫째"]);
    await session.send("고친 둘째", [], "queue");
    await until(() => log.started.length === 2 && session.lifecycle === "idle");
    expect(log.started[1]).toMatchObject({ resume: session.id, resumeSessionAt: "a1" });
    await manager.shutdown();
  });

  test("보관하고 오래 쉰 세션과 어디에도 없는 세션의 첨부 폴더만 지운다", async () => {
    const { manager, project, state, uploads, data } = await setup();
    const kept = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => kept.lifecycle === "idle");
    const archived = await manager.create({ cwd: project, prompt: "안녕", attachments: [] });
    await until(() => archived.lifecycle === "idle");
    await archived.close("idle");
    state.patchSession(archived.id, { archived: true, updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 });
    const orphan = "0f0f0f0f-0000-4000-8000-000000000000";
    uploads.sessionDirectory(orphan);
    const removed = manager.cleanupUploads(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(removed.sort()).toEqual([archived.id, orphan].sort());
    expect(existsSync(join(data, "uploads", kept.id))).toBe(true);
    await manager.shutdown();
  });
});

function realpath(path: string): string {
  return realpathSync(path);
}
