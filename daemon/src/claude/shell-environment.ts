/**
 * 로그인 셸 env 와 claude 실행 파일.
 *
 * Mac 앱(Electron)이 띄운 데몬은 로그인 셸의 PATH 를 물려받지 못한다. 로그인·인터랙티브 셸을 한 번 띄워
 * 그 안의 env 를 받아 SDK 의 `env` 로 준다 — .zshrc 가 세우는 PATH·CA 번들이 claude 에 닿는다.
 * 셸에는 데몬의 env 를 통째로 넘기지 않는다 — 앱 특유 변수(CLAUDECODE 등)가 새는 통로라 신원·로케일만 고른다
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const MARKER = "__LIGHT_SESSION_ENV__";

/** 셸이 스스로 채우는 값 — claude 프로세스에는 뜻이 없거나 틀리다 */
const SHELL_OWNED_KEYS: ReadonlySet<string> = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);

/** passwd 의 로그인 셸. Bun 의 `userInfo().shell` 은 $SHELL 만 읽고 없으면 "unknown" 이다 */
function passwdShell(): string | undefined {
  try {
    const shell = userInfo().shell;
    return shell === null || shell === "" || !shell.startsWith("/") ? undefined : shell;
  } catch {
    return undefined;
  }
}

function loginShell(inherited: Readonly<Record<string, string | undefined>> = process.env): string {
  return passwdShell() ?? (inherited.SHELL?.startsWith("/") === true ? inherited.SHELL : undefined) ?? "/bin/zsh";
}

/** GUI 앱의 축소된 PATH 보강 */
function augmentedPATH(current: string | undefined, home: string): string {
  const path = current ?? "";
  const prepend = [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"].filter((dir) => !path.split(":").includes(dir));
  return [...prepend, ...(path === "" ? [] : [path])].join(":");
}

/** 셸에 줄 env — 신원·로케일만 물려주고 HOME·SHELL·PATH 를 세운다 */
function baseEnvironment(home: string, shell: string, inherited: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const environment: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const key of ["USER", "LOGNAME", "TMPDIR", "LANG"]) {
    const value = inherited[key];
    if (value !== undefined && value !== "") environment[key] = value;
  }
  environment.HOME = home;
  environment.SHELL = shell;
  environment.PATH = augmentedPATH(inherited.PATH, home);
  if ((environment.LANG ?? "") === "") environment.LANG = "en_US.UTF-8";
  return environment;
}

/** 셸이 낸 stdout 에서 표식 뒤의 `env -0` 덤프를 읽는다 — 표식이 없으면 undefined */
export function parseEnvironmentDump(stdout: string): Record<string, string> | undefined {
  const at = stdout.lastIndexOf(MARKER);
  if (at === -1) return undefined;
  const environment: Record<string, string> = {};
  for (const entry of stdout.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (SHELL_OWNED_KEYS.has(key)) continue;
    environment[key] = entry.slice(eq + 1);
  }
  return Object.keys(environment).length === 0 ? undefined : environment;
}

export type ShellRunner = (shell: string, args: string[], env: Record<string, string>, cwd: string) => Promise<string | undefined>;

/** rc 파일이 터미널을 기다리며 멈추는 머신에서 세션 기동이 붙들리지 않게 */
const CAPTURE_TIMEOUT_MS = 8_000;

const spawnShellRunner: ShellRunner = async (shell, args, env, cwd) => {
  try {
    const child = Bun.spawn([shell, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), CAPTURE_TIMEOUT_MS);
    try {
      const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
};

/** 세션이 받을 env — 로그인 셸은 한 번만 띄우고 결과를 쥔다. 셸이 실패하면 셸에 주려던 env 그대로 */
export class ShellEnvironment {
  private cached: Promise<Record<string, string>> | undefined;

  constructor(private readonly home: string, private readonly runner: ShellRunner = spawnShellRunner) {}

  environment(): Promise<Record<string, string>> {
    this.cached ??= this.capture();
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async capture(): Promise<Record<string, string>> {
    const shell = loginShell();
    const environment = baseEnvironment(this.home, shell);
    const stdout = await this.runner(shell, ["-l", "-i", "-c", `printf '%s' '${MARKER}'; /usr/bin/env -0`], environment, this.home);
    const captured = stdout === undefined ? undefined : parseEnvironmentDump(stdout);
    return captured ?? environment;
  }
}

/**
 * 실행 파일 이름을 그 PATH 에서 찾아 절대 경로로. 패키징된 앱에는 SDK 에 딸린 CLI 가 없다 — 사람이 설치한 `claude` 가 돌아야 한다.
 * 심볼릭 링크는 끝까지 따라간다(SDK 가 확장자로 실행 방식을 가른다)
 */
export function resolveExecutable(name: string, path: string | undefined): string | undefined {
  const usable = (candidate: string): string | undefined => {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) return undefined;
      return realpathSync(candidate);
    } catch {
      return undefined;
    }
  };
  if (name === "") return undefined;
  if (name.includes("/")) return name.startsWith("/") ? usable(name) : undefined;
  for (const directory of (path ?? "").split(":")) {
    if (directory === "") continue;
    const found = usable(join(directory, name));
    if (found !== undefined) return found;
  }
  return undefined;
}
