/**
 * Mac 앱의 로컬 API — 이 Mac 에서 바로 온 요청 + 데이터 폴더의 토큰만 받는다(`security.ts`).
 * Claude Code 로그인 상태는 SDK 의 계정 정보 조회로만 확인한다 — OAuth 토큰과 키체인은 읽지 않는다
 */
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { errorText, logPath } from "./log.ts";
import type { Notifier } from "./push/notifier.ts";
import { json, VERSION } from "./server.ts";
import type { QueryFunction } from "./session/live-session.ts";
import type { SessionManager } from "./session/manager.ts";
import { sessionEnvironment } from "./session/options.ts";
import type { ShellEnvironment } from "./claude/shell-environment.ts";
import type { DeviceStore, SettingsStore } from "./stores.ts";
import type { ServeStatus, Tailscale, TailscaleStatus } from "./tailscale.ts";

export interface ClaudeStatus {
  installed: boolean;
  path?: string;
  version?: string;
  loggedIn?: boolean;
  /** 로그인 방식(구독·API 키) — 이메일 같은 개인 정보는 싣지 않는다 */
  subscriptionType?: string;
  apiProvider?: string;
  error?: string;
}

export interface LocalContext {
  settings: SettingsStore;
  manager: SessionManager;
  devices: DeviceStore;
  notifier: Notifier;
  tailscale: Tailscale;
  shell: ShellEnvironment;
  query: QueryFunction;
  startedAt: number;
  blocked: () => string | undefined;
  network: () => { tailscale?: TailscaleStatus; serve?: ServeStatus };
  refreshNetwork: () => Promise<void>;
  shutdown: () => void;
}

let claudeCache: { at: number; status: ClaudeStatus } | undefined;

/** 턴 없는 세션을 잠깐 띄워 계정 정보만 묻는다 — 모델을 부르지 않는다 */
async function claudeStatus(context: LocalContext, force = false): Promise<ClaudeStatus> {
  if (!force && claudeCache !== undefined && Date.now() - claudeCache.at < 5 * 60_000) return claudeCache.status;
  const path = await context.manager.claudeExecutable();
  if (path === undefined) return { installed: false };
  const status: ClaudeStatus = { installed: true, path };
  try {
    const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    status.version = (await new Response(child.stdout).text()).trim().split(" ")[0];
  } catch {
    // 버전을 못 읽어도 로그인은 본다
  }
  const never: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  let query: Query | undefined;
  try {
    const environment = sessionEnvironment(await context.shell.environment(), context.settings.current.authMode);
    query = context.query({ prompt: never, options: { cwd: process.env.HOME ?? "/", env: environment, pathToClaudeCodeExecutable: path, settingSources: [] } });
    const info = await Promise.race([
      query.accountInfo(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("계정 정보 조회가 15초 안에 끝나지 않았습니다.")), 15_000)),
    ]);
    status.loggedIn = info.tokenSource !== undefined || info.apiKeySource !== undefined || info.subscriptionType !== undefined
      || (info.apiProvider !== undefined && info.apiProvider !== "firstParty");
    if (info.subscriptionType !== undefined) status.subscriptionType = info.subscriptionType;
    if (info.apiProvider !== undefined) status.apiProvider = info.apiProvider;
  } catch (error) {
    status.error = errorText(error);
  } finally {
    try {
      query?.close();
    } catch {
      // 이미 닫혔다
    }
  }
  claudeCache = { at: Date.now(), status };
  return status;
}

export async function localAPI(context: LocalContext, request: Request, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/^\/local\//, "");
  switch (`${method} ${path.split("/")[0]}`) {
    case "GET status": {
      const network = context.network();
      const settings = context.settings.current;
      const blocked = context.blocked();
      return json({
        daemon: { state: blocked === undefined ? "running" : "blocked", ...(blocked !== undefined ? { reason: blocked } : {}), version: VERSION, pid: process.pid, port: settings.port, startedAt: context.startedAt },
        counts: context.manager.counts(),
        tailscale: network.tailscale ?? null,
        serve: network.serve ?? null,
        pwaUrl: network.serve?.url ?? null,
        claude: await claudeStatus(context, url.searchParams.get("refresh") === "1"),
        devices: context.devices.all().map((device) => ({
          id: device.id, label: device.label ?? null, login: device.login ?? null, installed: device.installed === true, subscribed: device.subscription !== undefined,
          lastSeenAt: device.lastSeenAt, lastPushOkAt: device.lastPushOkAt ?? null, lastPushError: device.lastPushError ?? null,
          expiredAt: device.expiredAt ?? null,
        })),
        logPath: logPath() ?? null,
      });
    }
    case "GET settings":
      return json(context.settings.current);
    case "PATCH settings":
      return json(context.settings.update(await request.json()));
    case "POST network":
      await context.refreshNetwork();
      return json(context.network());
    case "POST serve": {
      const result = await context.tailscale.registerServe(context.settings.current.port);
      await context.refreshNetwork();
      return json(result, result.ok ? 200 : 500);
    }
    case "POST push":
      return json(await context.notifier.notify({ kind: "test", sessionId: "", project: "light", body: "Mac 에서 보낸 테스트 알림입니다." }));
    case "DELETE devices": {
      const id = decodeURIComponent(path.split("/")[1] ?? "");
      return json({ ok: context.devices.remove(id) });
    }
    case "POST shutdown":
      setTimeout(() => context.shutdown(), 50);
      return json({ ok: true });
    default:
      return json({ error: "없는 경로입니다." }, 404);
  }
}
