/**
 * light Mac 앱 — 메뉴바 아이콘 하나와 설정 창 하나. 세션을 보거나 대화하는 화면은 만들지 않는다.
 * - 데몬을 띄우고 감시한다. 죽으면 10초 안에 다시 띄운다
 * - 메뉴바: 데몬·Tailscale·Claude Code 상태와 실행 중 세션·대기 요청 수
 * - 설정 창: 기기·설정·온보딩. 데몬의 로컬 API 를 데이터 폴더의 토큰으로 부른다
 * - 세션이 도는 동안 잠자기를 막고 로그인 시 실행을 건다
 * - 릴리스 설치본은 새 버전을 받아 두었다가 끌 때 갈아 끼운다(update.ts)
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, powerSaveBlocker, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { AppUpdater, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, realSeams, type UpdateState } from "./update";

const repoRoot = join(__dirname, "..", "..");
const dataDirectory = process.env.LIGHT_HOME ?? join(homedir(), "Library", "Application Support", "light");
// 앱 자체 상태는 데몬 데이터 폴더와 섞지 않는다
app.setName("light");
app.setPath("userData", process.env.LIGHT_APP_DATA ?? join(app.getPath("appData"), "light-mac"));
const appStatePath = join(app.getPath("userData"), "app-state.json");

interface AppState {
  onboarded?: boolean;
  /** 마지막으로 본 PWA 주소 — Mac 이름이 바뀌어 주소가 바뀌면 알린다 */
  lastPwaUrl?: string;
}

interface DaemonStatus {
  daemon: { state: string; reason?: string; version: string; pid: number; port: number };
  counts: { running: number; alive: number; pending: number };
  tailscale: { installed: boolean; loggedIn: boolean; dnsName?: string; loginName?: string; httpsEnabled: boolean; phones: { name: string; online: boolean }[]; backendState?: string } | null;
  serve: { configured: boolean; funnel: boolean; url?: string } | null;
  pwaUrl: string | null;
  claude: { installed: boolean; version?: string; loggedIn?: boolean; subscriptionType?: string; error?: string };
  devices: { id: string; label: string | null; installed: boolean; subscribed: boolean; lastSeenAt: number; lastPushOkAt: number | null; expiredAt: number | null }[];
  logPath: string | null;
}

let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let daemon: ChildProcess | undefined;
let quitting = false;
let restartTimer: NodeJS.Timeout | undefined;
let crashes: number[] = [];
let status: DaemonStatus | undefined;
let statusError: string | undefined;
let sleepBlocker: number | undefined;
let updater: AppUpdater | undefined;

function readAppState(): AppState {
  try {
    return JSON.parse(readFileSync(appStatePath, "utf8")) as AppState;
  } catch {
    return {};
  }
}

function writeAppState(patch: Partial<AppState>): void {
  mkdirSync(dirname(appStatePath), { recursive: true });
  writeFileSync(appStatePath, JSON.stringify({ ...readAppState(), ...patch }, null, 2));
}

function settingsPort(): number {
  try {
    const settings = JSON.parse(readFileSync(join(dataDirectory, "settings.json"), "utf8")) as { port?: number };
    return settings.port ?? 47615;
  } catch {
    return 47615;
  }
}

function localToken(): string {
  try {
    return readFileSync(join(dataDirectory, "local-token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function local<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${settingsPort()}/local/${path}`, {
    method,
    headers: { "X-Light-Token": localToken(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `데몬이 ${response.status} 로 답했습니다.`);
  return parsed;
}

// MARK: - 데몬 감시

/** GUI 앱은 로그인 셸의 PATH 를 물려받지 못한다 — bun 은 알려진 자리에서 찾는다 */
function bunPath(): string | undefined {
  return [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((candidate) => existsSync(candidate));
}

/** 패키징된 앱은 `bun build --compile` 로 묶은 데몬과 PWA 를 Resources 에 싣는다(scripts/build-mac.sh) */
function daemonCommand(): { command: string; args: string[]; env: Record<string, string> } | undefined {
  const packaged = join(process.resourcesPath, "light-daemon");
  if (app.isPackaged && existsSync(packaged)) {
    return { command: packaged, args: [], env: { LIGHT_PWA_DIST: join(process.resourcesPath, "pwa") } };
  }
  const bun = bunPath();
  if (bun === undefined) return undefined;
  return { command: bun, args: [join(repoRoot, "daemon", "src", "main.ts")], env: {} };
}

function startDaemon(): void {
  if (daemon !== undefined || quitting) return;
  const plan = daemonCommand();
  if (plan === undefined) {
    statusError = "bun 을 찾지 못했습니다. https://bun.sh 에서 설치하십시오.";
    refreshMenu();
    return;
  }
  const child = spawn(plan.command, plan.args, {
    cwd: repoRoot,
    env: { ...process.env, ...plan.env, LIGHT_HOME: dataDirectory, LIGHT_EXIT_ON_STDIN_EOF: "1" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  daemon = child;
  child.on("exit", (code) => {
    if (daemon === child) daemon = undefined;
    if (quitting) return;
    // 죽으면 다시 띄운다 — 연달아 죽으면 간격을 늘린다(최대 8초, 10초 안)
    const now = Date.now();
    crashes = [...crashes.filter((at) => now - at < 60_000), now];
    const delay = Math.min(8_000, 500 * 2 ** (crashes.length - 1));
    statusError = `데몬이 종료 코드 ${code ?? "?"} 로 끝나 ${Math.round(delay / 1000)}초 뒤 다시 띄웁니다.`;
    refreshMenu();
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startDaemon, delay);
  });
}

async function restartDaemon(): Promise<void> {
  const child = daemon;
  if (child === undefined) {
    startDaemon();
    return;
  }
  crashes = [];
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 15_000);
  });
}

async function pollStatus(): Promise<void> {
  try {
    status = await local<DaemonStatus>("GET", "status");
    statusError = status.daemon.state === "blocked" ? status.daemon.reason : undefined;
    applyPowerAndLogin();
    watchAddress();
  } catch (error) {
    status = undefined;
    // 띠가 할 일까지 말한다 — 메뉴 막대의 두 항목은 어느 화면에서나 닿는다
    statusError ??= `데몬에 닿지 않습니다(${error instanceof Error ? error.message : String(error)}). 메뉴 막대의 light 에서 「데몬 다시 시작」을 누르고, 그래도 안 되면 「로그 열기」로 까닭을 보십시오.`;
  }
  refreshMenu();
  window?.webContents.send("status", { status: status ?? null, error: statusError ?? null });
}

/** 세션이 도는 동안 잠자기를 막는다 — 덮개 닫힘은 막지 못한다 */
async function applyPowerAndLogin(): Promise<void> {
  let settings: { preventSleep?: boolean; launchAtLogin?: boolean } = {};
  try {
    settings = await local("GET", "settings");
  } catch {
    return;
  }
  const busy = (status?.counts.alive ?? 0) > 0;
  if (settings.preventSleep === true && busy && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if ((!busy || settings.preventSleep !== true) && sleepBlocker !== undefined) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = undefined;
  }
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== (settings.launchAtLogin === true)) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin === true });
  }
}

/** Mac 이름이 바뀌어 ts.net 주소가 바뀌면 PWA 와 푸시 구독이 옛 주소에 묶인다 — 알리고 다시 설치하게 한다 */
function watchAddress(): void {
  const url = status?.pwaUrl ?? undefined;
  if (url === undefined) return;
  const previous = readAppState().lastPwaUrl;
  if (previous !== undefined && previous !== url && Notification.isSupported()) {
    new Notification({ title: "light 주소가 바뀌었습니다", body: `${url} — 폰에서 새 주소를 열고 홈 화면에 다시 추가하십시오.` }).show();
  }
  if (previous !== url) writeAppState({ lastPwaUrl: url });
}

// MARK: - 업데이트

function startUpdater(): void {
  updater = new AppUpdater({
    changed: (state) => {
      refreshMenu();
      window?.webContents.send("update", state);
    },
    ready: (version) => {
      if (!Notification.isSupported()) return;
      new Notification({ title: `light ${version} 을 받아 두었습니다`, body: "light 를 끄면 바뀝니다. 메뉴 막대의 light 에서 바로 다시 시작할 수도 있습니다." }).show();
    },
  }, realSeams((url, init) => net.fetch(url, init), app.getPath("exe"), join(app.getPath("userData"), "updates"), app.isPackaged));
  const receiver = updater;
  void receiver.start().then(() => {
    if (!receiver.receiving) return;
    setTimeout(() => void receiver.check(), FIRST_CHECK_DELAY_MS);
    setInterval(() => void receiver.check(), CHECK_INTERVAL_MS);
  });
}

/** [다시 시작해 업데이트] — 턴이 도는 세션이 있으면 거절한다. 끄면 before-quit 이 갈아 끼울 셸을 띄운다 */
async function restartToUpdate(): Promise<void> {
  if (updater === undefined) throw new Error("받아 둔 버전이 없습니다.");
  const running = await local<DaemonStatus>("GET", "status").then((value) => value.counts.running, () => 0);
  if (running > 0) throw new Error(`세션 ${running}개가 턴을 도는 중입니다. 끝난 뒤 다시 누르십시오.`);
  updater.restart();
  app.quit();
}

// MARK: - 메뉴바

function refreshMenu(): void {
  if (tray === undefined) return;
  const counts = status?.counts;
  const tailscale = status?.tailscale;
  const claude = status?.claude;
  const daemonLine = status === undefined ? `light — ${statusError ?? "데몬을 띄우는 중…"}`
    : status.daemon.state === "blocked" ? `light — 멈춤: ${status.daemon.reason ?? ""}`
    : `light — 실행 중 · 세션 ${counts?.alive ?? 0}개 · 대기 ${counts?.pending ?? 0}건`;
  const tailscaleLine = tailscale == null ? "Tailscale: 확인 중"
    : !tailscale.installed ? "Tailscale: 설치되지 않음"
    : !tailscale.loggedIn ? `Tailscale: 로그인 필요(${tailscale.backendState ?? "?"})`
    : !tailscale.httpsEnabled ? "Tailscale: HTTPS 인증서 꺼짐"
    : status?.serve?.configured === true ? `Tailscale: serve 연결됨` : "Tailscale: serve 등록 필요";
  const claudeLine = claude === undefined ? "Claude Code: 확인 중"
    : !claude.installed ? "Claude Code: 설치되지 않음"
    : `Claude Code ${claude.version ?? ""} · ${claude.loggedIn === true ? `로그인됨${claude.subscriptionType !== undefined ? `(${claude.subscriptionType})` : ""}` : "로그인 필요"}`;
  const staged = updater?.value.staged ?? null;
  tray.setTitle((counts?.pending ?? 0) > 0 ? ` ${counts!.pending}` : "");
  tray.setToolTip(daemonLine);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: daemonLine, enabled: false },
    { label: tailscaleLine, enabled: false },
    { label: claudeLine, enabled: false },
    { type: "separator" },
    ...(staged !== null ? [
      {
        label: `다시 시작해 업데이트(${staged})`,
        click: () => void restartToUpdate().catch((error: unknown) => {
          void dialog.showMessageBox({ type: "info", message: "업데이트하지 않았습니다", detail: error instanceof Error ? error.message : String(error) });
        }),
      },
      { type: "separator" as const },
    ] : []),
    ...(status?.pwaUrl != null ? [{ label: "PWA 주소 복사", click: () => clipboard.writeText(status!.pwaUrl!) }] : []),
    { label: "설정 열기…", click: () => openWindow("settings") },
    { label: "시작하기…", click: () => openWindow("onboarding") },
    { label: "데몬 다시 시작", click: () => void restartDaemon() },
    { label: "로그 열기", click: () => void openLogs() },
    { type: "separator" },
    { label: "light 종료", click: () => app.quit() },
  ]));
}

function openLogs(): Promise<string> {
  return shell.openPath(status?.logPath ?? join(dataDirectory, "logs"));
}

function openWindow(view: "settings" | "onboarding"): void {
  if (window !== undefined && !window.isDestroyed()) {
    window.webContents.send("view", view);
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 720, height: 760, minWidth: 560, minHeight: 520, title: "light", show: false,
    // 제목 막대 자리는 창의 머리(ui/style.css 의 .toolbar)가 맡는다 — 신호등 단추를 52px 머리 가운데 높이에 둔다
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void window.loadFile(join(__dirname, "..", "ui", "index.html"), { hash: view });
  window.once("ready-to-show", () => window?.show());
  if (process.env.LIGHT_SMOKE === "1") {
    window.webContents.on("console-message", (event) => process.stdout.write(`[window] ${event.level} ${event.message}\n`));
    window.webContents.on("preload-error", (_event, path, error) => process.stdout.write(`[preload] ${path} ${error.message}\n`));
  }
  window.on("closed", () => {
    window = undefined;
    if (process.platform === "darwin") app.dock?.hide();
  });
  if (process.platform === "darwin") void app.dock?.show();
}

// MARK: - 설정 창이 부르는 것

function registerIPC(): void {
  ipcMain.handle("status", async () => {
    await pollStatus();
    return { status: status ?? null, error: statusError ?? null };
  });
  ipcMain.handle("settings:get", () => local("GET", "settings"));
  ipcMain.handle("settings:update", async (_event, patch: unknown) => {
    const result = await local("PATCH", "settings", patch);
    void pollStatus();
    return result;
  });
  ipcMain.handle("network:refresh", () => local("POST", "network"));
  ipcMain.handle("serve:register", () => local("POST", "serve"));
  ipcMain.handle("push:test", () => local("POST", "push"));
  ipcMain.handle("devices:remove", (_event, id: string) => local("DELETE", `devices/${encodeURIComponent(id)}`));
  ipcMain.handle("daemon:restart", () => restartDaemon());
  ipcMain.handle("logs:open", () => openLogs());
  ipcMain.handle("qr", (_event, text: string) => QRCode.toDataURL(text, { margin: 1, width: 280 }));
  ipcMain.handle("clipboard", (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle("external", (_event, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle("folder:choose", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "multiSelections"], title: "프로젝트 폴더" });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("onboarded", () => writeAppState({ onboarded: true }));
  ipcMain.handle("update:get", (): UpdateState | null => updater?.value ?? null);
  // 확인은 곧바로 돌아온다 — 진행은 "update" 로 간다
  ipcMain.handle("update:check", () => void updater?.check());
  ipcMain.handle("update:restart", () => restartToUpdate());
}

// MARK: - 수명

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openWindow("settings"));
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide();
    const icon = nativeImage.createFromPath(join(__dirname, "..", "assets", "trayTemplate.png"));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    registerIPC();
    startUpdater();
    refreshMenu();
    startDaemon();
    setInterval(() => void pollStatus(), 3_000);
    setTimeout(() => void pollStatus(), 1_500);
    // 처음 실행하면 온보딩
    if (process.env.LIGHT_SMOKE_VIEW === "settings") openWindow("settings");
    else if (readAppState().onboarded !== true) openWindow("onboarding");
    if (process.env.LIGHT_SMOKE_CRASH === "1") {
      // 시험용 — 데몬을 SIGKILL 로 죽이고 다시 뜨는지 본다(10초 안)
      setTimeout(() => {
        const before = daemon?.pid;
        const killedAt = Date.now();
        daemon?.kill("SIGKILL");
        const check = setInterval(async () => {
          await pollStatus();
          if (status !== undefined && status.daemon.pid !== before) {
            clearInterval(check);
            process.stdout.write(`${JSON.stringify({ before, after: status.daemon.pid, recoveredMs: Date.now() - killedAt })}\n`);
            app.quit();
          } else if (Date.now() - killedAt > 15_000) {
            clearInterval(check);
            process.stdout.write(`${JSON.stringify({ before, recovered: false })}\n`);
            app.quit();
          }
        }, 250);
      }, 4_000);
    }
    if (process.env.LIGHT_SMOKE === "1") {
      // 시험용 — 데몬 상태를 한 번 읽고 끝낸다
      setTimeout(async () => {
        await pollStatus();
        const shot = process.env.LIGHT_SMOKE_SHOT;
        if (shot !== undefined && window !== undefined) writeFileSync(shot, (await window.webContents.capturePage()).toPNG());
        process.stdout.write(`${JSON.stringify({ daemon: status?.daemon ?? null, counts: status?.counts ?? null, claude: status?.claude ?? null, error: statusError ?? null, window: window !== undefined })}\n`);
        app.quit();
      }, 9_000);
    }
  }).catch((error: unknown) => {
    dialog.showErrorBox("light", String(error));
  });
  app.on("window-all-closed", () => {
    // 메뉴바 앱이다 — 창을 닫아도 남는다
  });
  app.on("before-quit", () => {
    quitting = true;
    clearTimeout(restartTimer);
    if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker);
    // 받아 둔 버전이 있으면 앱과 데몬이 내려간 뒤 갈아 끼운다
    updater?.handOff(process.pid, daemon?.pid);
    // 데몬은 stdin 이 닫히면 세션을 모두 닫고 끝난다
    daemon?.stdin?.end();
    daemon?.kill("SIGTERM");
  });
}
