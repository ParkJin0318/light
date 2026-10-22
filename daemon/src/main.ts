/**
 * light 데몬 진입점 — Mac 앱이 띄우고 감시한다(죽으면 다시 띄운다). 혼자서도 돈다: `bun daemon/src/main.ts`.
 * 끝날 때는 모든 세션을 닫아 고아 프로세스를 남기지 않는다
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ClaudeHistory } from "./claude/history.ts";
import { ShellEnvironment } from "./claude/shell-environment.ts";
import { writeJSON } from "./json-file.ts";
import { localAPI, type LocalContext } from "./local-api.ts";
import { configureLog, errorText, log } from "./log.ts";
import { lightPaths } from "./paths.ts";
import { Notifier } from "./push/notifier.ts";
import { loadOrCreateVapid } from "./push/web-push.ts";
import { startServer, VERSION } from "./server.ts";
import { SessionManager } from "./session/manager.ts";
import { DeviceStore, SettingsStore, StateStore } from "./stores.ts";
import { Tailscale, type ServeStatus, type TailscaleStatus } from "./tailscale.ts";
import { Uploads } from "./uploads.ts";

const paths = lightPaths();
configureLog(paths.logs);

/** Mac 앱이 로컬 API 에 싣는 토큰 — 평문 한 줄, 0600 */
function localToken(): string {
  if (existsSync(paths.localToken)) {
    const token = readFileSync(paths.localToken, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  writeFileSync(paths.localToken, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Mac 앱이 데몬이 꺼져 있어도 읽는 마지막 상태 */
function writeStatus(state: "running" | "blocked" | "stopped" | "failed", extra: Record<string, unknown> = {}): void {
  try {
    writeJSON(paths.status, { state, pid: process.pid, version: VERSION, at: new Date().toISOString(), ...extra });
  } catch {
    // 상태를 못 남겨도 돈다
  }
}

async function main(): Promise<void> {
  const settings = new SettingsStore(paths.settings);
  const state = new StateStore(paths.state);
  const devices = new DeviceStore(paths.devices);
  const uploads = new Uploads(paths.uploads);
  uploads.cleanupStaging();
  const history = new ClaudeHistory(paths.claudeHome);
  const shell = new ShellEnvironment(paths.home);
  const vapid = await loadOrCreateVapid(paths.vapid);
  const notifier = new Notifier({ devices, settings: () => settings.current, vapid, pushLog: paths.pushLog });
  const manager = new SessionManager({ settings, state, history, uploads, notifier, shell, query, claudeHome: paths.claudeHome });
  const tailscale = new Tailscale();
  const token = localToken();

  let network: { tailscale?: TailscaleStatus; serve?: ServeStatus } = {};
  let blockedReason: string | undefined;
  const refreshNetwork = async (): Promise<void> => {
    const [status, serve] = await Promise.all([tailscale.status(), tailscale.serveStatus(settings.current.port)]);
    network = { tailscale: status, serve };
    // 허용 목록의 기본은 이 Mac 의 소유자 하나다
    if (settings.current.allowedLogins.length === 0 && status.loginName !== undefined) settings.update({ allowedLogins: [status.loginName] });
    const reason = serve.funnel ? "Tailscale Funnel 이 켜져 있어 데몬이 시작을 거부했습니다. Funnel 을 끄면 다시 엽니다." : undefined;
    if (reason !== blockedReason) {
      blockedReason = reason;
      log(reason === undefined ? "info" : "warn", reason === undefined ? "unblocked" : "blocked", {});
      writeStatus(reason === undefined ? "running" : "blocked", reason === undefined ? {} : { reason });
    }
  };
  await refreshNetwork();
  const networkTimer = setInterval(() => void refreshNetwork().catch(() => undefined), 60_000);
  settings.onChange(() => shell.invalidate());

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", {});
    clearInterval(networkTimer);
    notifier.shutdown();
    // 먼저 듣기를 멈춘다 — 다시 띄운 데몬이 세션을 닫는 동안에도 포트를 잡을 수 있게
    server.stop(true);
    await manager.shutdown();
    writeStatus("stopped");
    process.exit(code);
  };

  const localContext: LocalContext = {
    settings, manager, devices, notifier, tailscale, shell, query, startedAt: Date.now(),
    blocked: () => blockedReason, network: () => network, refreshNetwork, shutdown: () => void shutdown(0),
  };
  const port = settings.current.port;
  let server: ReturnType<typeof startServer>;
  try {
    server = startServer({
      settings, manager, devices, uploads, notifier, vapid, pwaDist: paths.pwaDist, localToken: token, hostId: state.hostId,
      blocked: () => blockedReason, funnelOn: () => network.serve?.funnel === true,
      trustedHosts: () => (network.tailscale?.dnsName === undefined ? [] : [network.tailscale.dnsName]),
      local: (request, url) => localAPI(localContext, request, url),
    }, port);
  } catch (error) {
    log("error", "listen failed", { port, error: errorText(error) });
    writeStatus("failed", { reason: `127.0.0.1:${port} 에서 받지 못했습니다: ${errorText(error)}` });
    process.exit(1);
  }
  manager.startTimers();
  writeStatus(blockedReason === undefined ? "running" : "blocked", { port, ...(blockedReason !== undefined ? { reason: blockedReason } : {}) });
  log("info", "listening", { url: `http://127.0.0.1:${port}`, pwa: network.serve?.url ?? null, version: VERSION });
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  // Mac 앱이 죽으면 stdin 이 닫힌다 — 고아 데몬으로 남지 않는다
  if (process.env.LIGHT_EXIT_ON_STDIN_EOF === "1") {
    process.stdin.on("end", () => void shutdown(0));
    process.stdin.resume();
  }
}

main().catch((error) => {
  log("error", "daemon crashed", { error: errorText(error) });
  writeStatus("failed", { reason: errorText(error) });
  process.exit(1);
});
