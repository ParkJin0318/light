/**
 * README 스크린샷용 데모 데몬 — claude 대신 각본대로 SDK 메시지를 내는 가짜 `query()` 를 꽂아 띄운다.
 * 데이터·기록·프로젝트 폴더는 `LIGHT_DEMO_DIR`(기본 `.dev/screenshots`) 아래 새로 만들고 포트는 `LIGHT_DEMO_PORT`(기본 47699)다.
 * 권한 대기·질문 대기·실행 중 세션 셋이 자리를 잡으면 `sessions.json` 을 쓰고 「ready」를 찍는다. `sh scripts/screenshots.sh` 가 띄운다
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClaudeHistory } from "../../daemon/src/claude/history.ts";
import { ShellEnvironment } from "../../daemon/src/claude/shell-environment.ts";
import { configureLog } from "../../daemon/src/log.ts";
import { Notifier } from "../../daemon/src/push/notifier.ts";
import { generateVapidKeys } from "../../daemon/src/push/web-push.ts";
import { startServer } from "../../daemon/src/server.ts";
import { SessionManager } from "../../daemon/src/session/manager.ts";
import { DeviceStore, SettingsStore, StateStore } from "../../daemon/src/stores.ts";
import { Uploads } from "../../daemon/src/uploads.ts";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const demo = process.env.LIGHT_DEMO_DIR ?? join(root, ".dev", "screenshots");
const port = Number(process.env.LIGHT_DEMO_PORT ?? 47699);
const MODEL = "claude-opus-5-5";

// 지난번 데이터만 지운다 — 같은 폴더에 로그를 쓰는 screenshots.sh 의 파일은 남긴다
const data = join(demo, "light-home");
const claudeHome = join(demo, "claude-home");
const code = join(demo, "code");
for (const directory of [data, claudeHome, code]) rmSync(directory, { recursive: true, force: true });
mkdirSync(join(claudeHome, "projects"), { recursive: true });
const PROJECTS = ["shop-api", "docs-site", "ios-app", "infra", "blog"];
const folder = (name: string) => join(code, name);
for (const name of PROJECTS) mkdirSync(folder(name), { recursive: true });

// MARK: - 지난 기록 — 프로젝트별 묶음과 「Mac 기록」 줄

/** 사람 한 줄·답 한 줄짜리 기록 파일. 수정 시각을 `ageMinutes` 전으로 돌려 목록 순서와 시각을 정한다 */
function writeTranscript(project: string, title: string, prompt: string, answer: string, ageMinutes: number): string {
  const id = randomUUID();
  const cwd = folder(project);
  const directory = join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const at = Date.now() - ageMinutes * 60_000;
  const timestamp = new Date(at - 120_000).toISOString();
  const userID = randomUUID();
  const lines = [
    { type: "user", message: { role: "user", content: prompt }, uuid: userID, parentUuid: null, sessionId: id, cwd, timestamp, isSidechain: false },
    { type: "assistant", message: { id: "msg_0", role: "assistant", model: MODEL, content: [{ type: "text", text: answer }] }, uuid: randomUUID(), parentUuid: userID, sessionId: id, cwd, timestamp, isSidechain: false },
    { type: "ai-title", aiTitle: title, sessionId: id },
  ];
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  utimesSync(path, at / 1000, at / 1000);
  return id;
}

writeTranscript("shop-api", "주문 목록 API 를 커서 페이지네이션으로", "주문 목록 API 를 offset 대신 커서 방식으로 바꿔줘", "`GET /orders` 를 `created_at, id` 커서로 바꿨습니다. 시험 42개가 통과합니다.", 95);
writeTranscript("shop-api", "Stripe SDK 올리고 깨진 타입 고치기", "stripe 패키지 최신으로 올려줘", "18.2 로 올리고 바뀐 타입 세 곳을 고쳤습니다.", 60 * 26);
writeTranscript("shop-api", "재고 차감 경쟁 조건 재현 시험", "재고 차감이 동시에 들어오면 음수가 되는지 시험으로 재현해줘", "동시 요청 50개로 재현했고 `SELECT … FOR UPDATE` 로 막았습니다.", 60 * 50);
writeTranscript("docs-site", "검색 색인 빌드가 느린 원인 찾기", "docs 빌드할 때 검색 색인 만드는 데 3분 걸려. 왜 그래?", "페이지마다 전체 사이트맵을 다시 읽고 있었습니다. 한 번만 읽게 바꾸니 11초로 줄었습니다.", 310);
// 이 세션은 아래 가짜 레지스트리가 「Mac 터미널에서 열림」으로 만든다
const terminalSession = writeTranscript("ios-app", "콜드 스타트에서 푸시 딥링크가 안 열림", "앱이 꺼져 있을 때 푸시 누르면 딥링크가 안 열려", "`SceneDelegate` 가 연결 옵션의 알림을 읽기 전에 라우터가 준비되지 않았습니다. 준비된 뒤 처리하게 고쳤습니다.", 180);
writeTranscript("ios-app", "위젯 타임라인 갱신 주기 조정", "위젯이 너무 자주 갱신돼서 배터리를 먹어", "타임라인 정책을 15분 간격 `.after` 로 바꿨습니다.", 60 * 30);
writeTranscript("infra", "스테이징 DB 백업 크론 점검", "스테이징 DB 백업이 어제부터 안 돌았어", "IAM 역할의 S3 권한이 빠져 있었습니다. 정책을 고치고 수동 백업을 한 번 돌렸습니다.", 60 * 22);
writeTranscript("infra", "Terraform 모듈 정리", "안 쓰는 terraform 모듈 정리해줘", "참조 없는 모듈 네 개를 지웠고 plan 에 변경이 없습니다.", 60 * 70);
writeTranscript("blog", "다크 모드 색 대비 맞추기", "다크 모드에서 링크 색 대비가 낮아", "링크 색을 #8ab4ff 로 올려 대비 7.1:1 이 됐습니다.", 60 * 40);

// MARK: - 각본 — 살아 있는 세션 셋

type Step =
  | { emit: unknown; wait?: number }
  | { ask: { tool: string; input: Record<string, unknown>; toolUseID: string; suggestions?: unknown[] } }
  | { hang: true };

interface Scenario {
  project: string;
  prompt: string;
  title: string;
  steps: (session: string) => Step[];
}

const text = (body: string) => ({ type: "text", text: body });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
/** 턴 도구의 할 일 — 화면은 이 입력으로 할 일 띠를 그린다 */
const plan = (id: string, items: [string, "completed" | "in_progress" | "pending"][]) =>
  toolUse(id, "mcp__turn__update_plan", { items: items.map(([content, status]) => ({ content, status })), scope: "first_task" });
const assistant = (session: string, content: unknown[]) => ({
  type: "assistant", message: { id: `msg_${randomUUID().slice(0, 12)}`, role: "assistant", model: MODEL, content }, parent_tool_use_id: null, session_id: session, uuid: randomUUID(),
});
const result = (session: string, toolUseID: string, content: string) => ({
  type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseID, content }] }, parent_tool_use_id: null, session_id: session, uuid: randomUUID(),
});

const SHOP = folder("shop-api");
const DOCS = folder("docs-site");
const IOS = folder("ios-app");
const TEST_COMMAND = { command: "bun test test/webhooks", description: "웹훅 시험 실행" };
const QUESTION = {
  questions: [{
    question: "다크 모드 토글의 기본값을 어떻게 둘까요?",
    header: "기본값",
    multiSelect: false,
    options: [
      { label: "시스템 설정 따르기 (Recommended)", description: "처음엔 iOS 설정을 따르고, 토글로 덮어쓴다" },
      { label: "항상 라이트", description: "지금 앱과 같은 첫인상, 다크는 사용자가 켠다" },
      { label: "항상 다크", description: "새 디자인을 먼저 보여 준다" },
    ],
  }],
};

const SCENARIOS: Scenario[] = [
  {
    project: "shop-api",
    prompt: "결제 웹훅이 가끔 두 번 처리돼. 재시도 로직 보고 고쳐줘",
    title: "결제 웹훅 중복 처리 고치기",
    steps: (s) => [
      { emit: assistant(s, [plan("p1", [["웹훅 처리 흐름 읽기", "in_progress"], ["중복 처리 막기", "pending"], ["시험으로 확인", "pending"]])]), wait: 300 },
      { emit: result(s, "p1", "ok") },
      { emit: assistant(s, [text("웹훅 핸들러와 재시도 큐부터 보겠습니다.")]), wait: 400 },
      { emit: assistant(s, [toolUse("t1", "Grep", { pattern: "handlePaymentWebhook", path: `${SHOP}/src` })]), wait: 700 },
      { emit: result(s, "t1", "src/webhooks/payment.ts\nsrc/queue/retry.ts") },
      { emit: assistant(s, [toolUse("t2", "Read", { file_path: `${SHOP}/src/webhooks/payment.ts` })]), wait: 600 },
      { emit: result(s, "t2", "1\timport { enqueueRetry } from \"../queue/retry\";\n2\t\n3\texport async function handlePaymentWebhook(event: StripeEvent) {\n4\t  const order = await orders.byPaymentIntent(event.data.object.id);\n5\t  await orders.markPaid(order.id);\n6\t}") },
      { emit: assistant(s, [toolUse("t3", "Read", { file_path: `${SHOP}/src/queue/retry.ts` })]), wait: 500 },
      { emit: result(s, "t3", "1\texport function enqueueRetry(event) {\n2\t  queue.add(\"webhook\", event, { attempts: 5 });\n3\t}"), wait: 300 },
      { emit: assistant(s, [plan("p2", [["웹훅 처리 흐름 읽기", "completed"], ["중복 처리 막기", "in_progress"], ["시험으로 확인", "pending"]])]) },
      { emit: result(s, "p2", "ok") },
      { emit: assistant(s, [text("원인을 찾았습니다. 결제사는 응답이 늦으면 같은 이벤트를 다시 보내는데, 핸들러가 `event.id` 를 보지 않아 두 번 모두 `markPaid` 까지 갑니다.\n\n처리한 이벤트 id 를 `processed_events` 에 남기고 이미 있으면 건너뛰게 고치겠습니다.")]), wait: 500 },
      { emit: assistant(s, [toolUse("t4", "Edit", { file_path: `${SHOP}/src/webhooks/payment.ts`, old_string: "  const order = await orders.byPaymentIntent(event.data.object.id);", new_string: "  if (!(await processedEvents.claim(event.id))) return;\n  const order = await orders.byPaymentIntent(event.data.object.id);" })]), wait: 600 },
      { emit: result(s, "t4", `The file ${SHOP}/src/webhooks/payment.ts has been updated successfully.`) },
      { emit: assistant(s, [toolUse("t5", "Write", { file_path: `${SHOP}/test/webhooks/duplicate.test.ts`, content: "test(\"같은 이벤트를 두 번 받아도 한 번만 처리한다\", async () => {\n  await handlePaymentWebhook(event);\n  await handlePaymentWebhook(event);\n  expect(orders.markPaid).toHaveBeenCalledTimes(1);\n});\n" })]), wait: 500 },
      { emit: result(s, "t5", `File created successfully at: ${SHOP}/test/webhooks/duplicate.test.ts`) },
      { emit: assistant(s, [plan("p3", [["웹훅 처리 흐름 읽기", "completed"], ["중복 처리 막기", "completed"], ["시험으로 확인", "in_progress"]])]) },
      { emit: result(s, "p3", "ok") },
      { emit: assistant(s, [text("고쳤습니다. 중복 이벤트 시험을 더했으니 웹훅 시험을 돌려 확인하겠습니다.")]), wait: 400 },
      { emit: assistant(s, [toolUse("t6", "Bash", TEST_COMMAND)]) },
      { ask: { tool: "Bash", input: TEST_COMMAND, toolUseID: "t6", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" }] } },
      { hang: true },
    ],
  },
  {
    project: "ios-app",
    prompt: "설정 화면에 다크 모드 토글 붙여줘",
    title: "설정 화면에 다크 모드 토글",
    steps: (s) => [
      { emit: assistant(s, [text("설정 화면과 테마 처리부터 보겠습니다.")]), wait: 400 },
      { emit: assistant(s, [toolUse("q1", "Glob", { pattern: "**/Settings*.swift", path: IOS })]), wait: 500 },
      { emit: result(s, "q1", `${IOS}/App/Settings/SettingsView.swift\n${IOS}/App/Settings/SettingsStore.swift`) },
      { emit: assistant(s, [toolUse("q2", "Read", { file_path: `${IOS}/App/Settings/SettingsView.swift` })]), wait: 500 },
      { emit: result(s, "q2", "1\tstruct SettingsView: View {\n2\t  @Environment(SettingsStore.self) var store\n3\t  var body: some View {\n4\t    Form { NotificationSection(); AccountSection() }\n5\t  }\n6\t}"), wait: 300 },
      { emit: assistant(s, [text("지금은 앱이 시스템 모양을 그대로 따릅니다. 토글을 붙이기 전에 기본값을 정해야 합니다.")]), wait: 400 },
      { emit: assistant(s, [toolUse("q3", "AskUserQuestion", QUESTION)]) },
      { ask: { tool: "AskUserQuestion", input: QUESTION, toolUseID: "q3" } },
      { hang: true },
    ],
  },
  {
    project: "docs-site",
    prompt: "API 문서에 웹훅 서명 검증 예제 추가해줘",
    title: "웹훅 서명 검증 예제 추가",
    steps: (s) => [
      { emit: assistant(s, [text("웹훅 문서 위치를 찾겠습니다.")]), wait: 400 },
      { emit: assistant(s, [toolUse("d1", "Grep", { pattern: "webhook", path: `${DOCS}/content`, glob: "*.mdx" })]), wait: 600 },
      { emit: result(s, "d1", "content/api/webhooks.mdx\ncontent/guides/payments.mdx") },
      { emit: assistant(s, [toolUse("d2", "Read", { file_path: `${DOCS}/content/api/webhooks.mdx` })]), wait: 500 },
      { emit: result(s, "d2", "1\t# Webhooks\n2\t\n3\tlight sends a POST request for every event…"), wait: 300 },
      { emit: assistant(s, [text("TypeScript 와 Python 예제를 나란히 넣겠습니다.")]), wait: 300 },
      // 결과를 내지 않고 멈춘다 — 도는 도구와 「실행 중」으로 남는다
      { emit: assistant(s, [toolUse("d3", "Edit", { file_path: `${DOCS}/content/api/webhooks.mdx`, old_string: "## Retries", new_string: "## Verifying signatures\n\n<CodeGroup>…</CodeGroup>\n\n## Retries" })]) },
      { hang: true },
    ],
  },
];

const scenarioFor = (said: string) => SCENARIOS.find((candidate) => said.includes(candidate.prompt));

// MARK: - 가짜 query() — daemon/test/session.test.ts 의 대역과 같은 모양

interface FakeOptions {
  sessionId?: string;
  resume?: string;
  cwd?: string;
  permissionMode?: string;
  canUseTool?: (tool: string, input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;
}

function fakeQuery({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string | { type: string; text?: string }[] } }>; options?: FakeOptions }) {
  const session = options?.sessionId ?? options?.resume ?? randomUUID();
  const outbox: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let asking: AbortController | undefined;
  const emit = (message: unknown) => {
    outbox.push(message);
    wake?.();
  };
  void (async () => {
    for await (const message of prompt) {
      const content = message.message.content;
      const said = typeof content === "string" ? content : content.find((block) => block.type === "text")?.text ?? "";
      const scenario = scenarioFor(said);
      emit({ type: "system", subtype: "init", session_id: session, cwd: options?.cwd, model: MODEL, permissionMode: options?.permissionMode ?? "default", slash_commands: [], tools: [] });
      if (scenario === undefined) {
        emit(assistant(session, [text("데모 데몬은 정해진 대화만 합니다.")]));
        emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0, session_id: session });
        continue;
      }
      for (const step of scenario.steps(session)) {
        if ("emit" in step) {
          emit(step.emit);
          await Bun.sleep(step.wait ?? 150);
        } else if ("ask" in step) {
          asking = new AbortController();
          await options?.canUseTool?.(step.ask.tool, step.ask.input, {
            signal: asking.signal, toolUseID: step.ask.toolUseID, requestId: `req-${step.ask.toolUseID}`,
            ...(step.ask.suggestions !== undefined ? { suggestions: step.ask.suggestions } : {}),
          });
        } else {
          await new Promise(() => {});
        }
      }
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
    interrupt: async () => asking?.abort(),
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
    stopTask: async () => undefined,
    initializationResult: async () => ({
      models: [
        { value: "default", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
        { value: "haiku", displayName: "Haiku", description: "Haiku 5.5", supportsEffort: false },
      ],
    }),
    getSettings: async () => ({ applied: { model: MODEL, effort: "high" } }),
    getContextUsage: async () => ({ totalTokens: 38_400, maxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true }),
    askSideQuestion: async () => ({ response: "", synthetic: true }),
    backgroundTasks: async () => false,
    // 제목은 보낸 순간 부탁한다(live-session.ts) — 각본을 고르기 전이라 받은 글로 찾는다
    generateSessionTitle: async (description: string) => scenarioFor(description)?.title ?? "데모",
    getTaskOutput: async () => ({ output: "", total_bytes: 0, truncated: false }),
    rewindFiles: async () => ({ canRewind: false }),
    close: () => {
      ended = true;
      wake?.();
    },
  };
}

// MARK: - 띄우기

configureLog(join(data, "logs"), { quiet: true });
const settings = new SettingsStore(join(data, "settings.json"));
settings.update({ projectFolders: PROJECTS.map(folder), claudePath: "/bin/echo", prewarm: false, port, allowLocalhost: true, defaultEffort: "high" });
const devices = new DeviceStore(join(data, "devices.json"));
const state = new StateStore(join(data, "state.json"));
const uploads = new Uploads(join(data, "uploads"));
const vapid = await generateVapidKeys();
const notifier = new Notifier({ devices, settings: () => settings.current, vapid, pushLog: join(data, "logs", "push.jsonl") });
const manager = new SessionManager({
  settings, state, history: new ClaudeHistory(claudeHome), uploads, notifier,
  shell: new ShellEnvironment(data, async () => undefined), query: fakeQuery as never, claudeHome,
  registry: () => [{ pid: 4_000_001, sessionID: terminalSession, cwd: folder("ios-app"), status: "idle", entrypoint: "cli" }],
});
startServer({
  settings, manager, devices, uploads, notifier, vapid, pwaDist: join(root, "pwa", "dist"), localToken: "0".repeat(64), hostId: state.hostId,
  blocked: () => undefined, funnelOn: () => false, trustedHosts: () => [],
  local: async () => Response.json({ error: "데모 데몬에는 로컬 API 가 없습니다." }, { status: 404 }),
}, port);
manager.startTimers();
manager.refresh();

// 오래된 것부터 띄워 「열려 있음」 순서를 정한다
for (const scenario of [...SCENARIOS].reverse()) {
  await manager.create({ cwd: folder(scenario.project), prompt: scenario.prompt, attachments: [] });
  await Bun.sleep(1_200);
}
const deadline = Date.now() + 30_000;
for (;;) {
  const lifecycles = new Set(manager.summaries().map((summary) => summary.lifecycle));
  if (lifecycles.has("waitingPermission") && lifecycles.has("waitingQuestion")) break;
  if (Date.now() > deadline) throw new Error("데모 세션이 30초 안에 답을 기다리는 자리에 서지 않았습니다");
  await Bun.sleep(200);
}
const ids = Object.fromEntries([...manager.sessions.values()].map((session) => [session.cwd.split("/").pop(), session.id]));
writeFileSync(join(demo, "sessions.json"), JSON.stringify(ids, null, 2));
console.log(`ready http://127.0.0.1:${port}`);
