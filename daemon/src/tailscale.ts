/**
 * Tailscale 연동 — CLI 의 `status --json`·`serve status --json` 을 읽고 serve 를 등록한다.
 * 경계는 tailnet 이다. Funnel 이 켜져 있으면 공개 인터넷에서 들어올 수 있으므로 데몬은 serve 로 오는 요청을 모두 막고 이유를 보인다
 */
import { existsSync } from "node:fs";
import { jbool, jget, jobj, jstr, jstrings, type JSONValue } from "../../shared/src/session/json-value.ts";
import { errorText } from "./log.ts";

export type CommandRunner = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (command, args) => {
  try {
    const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { code: 127, stdout: "", stderr: errorText(error) };
  }
};

/** 앱 번들의 CLI 가 먼저다 — Mac App Store·독립 설치판 모두 여기에 있다 */
const CANDIDATES = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export interface TailscaleStatus {
  installed: boolean;
  /** BackendState — Running·NeedsLogin·Stopped… */
  backendState?: string;
  loggedIn: boolean;
  /** 이 Mac 의 MagicDNS 이름(끝의 점을 뗀다) */
  dnsName?: string;
  /** 이 Mac 소유자의 tailnet 로그인 — 허용 목록의 기본값 */
  loginName?: string;
  /** tailnet 의 HTTPS 인증서가 켜져 있다 */
  httpsEnabled: boolean;
  /** 이 Mac 소유자의 폰·태블릿 — 온보딩이 폰에 Tailscale 을 깔았는지 본다 */
  phones: TailnetPhone[];
  version?: string;
  error?: string;
}

export interface TailnetPhone {
  name: string;
  /** 지금 tailnet 에 붙어 있다 — 폰의 Tailscale 에서 VPN 을 끄면 false */
  online: boolean;
}

/** Peer 의 OS — iPadOS 도 iOS 로 온다 */
const PHONE_OS = new Set(["iOS", "android"]);

export interface ServeStatus {
  /** 이 데몬 포트로 프록시하는 serve 가 있다 */
  configured: boolean;
  /** Funnel 이 하나라도 켜져 있다 */
  funnel: boolean;
  /** PWA 주소 */
  url?: string;
}

export function parseStatus(json: JSONValue): Omit<TailscaleStatus, "installed"> {
  const backendState = jstr(jget(json, "BackendState"));
  const dns = jstr(jget(json, "Self", "DNSName"))?.replace(/\.$/, "");
  const userID = jget(json, "Self", "UserID");
  const login = userID === undefined ? undefined : jstr(jget(json, "User", String(userID), "LoginName"));
  const certDomains = jstrings(jget(json, "CertDomains"));
  const version = jstr(jget(json, "Version"));
  // 남의 기기는 세지 않는다 — 회사 tailnet 이면 같은 OS 의 폰이 여럿이다
  const phones = Object.values(jobj(jget(json, "Peer")) ?? {})
    .filter((peer) => PHONE_OS.has(jstr(jget(peer, "OS")) ?? "") && userID !== undefined && String(jget(peer, "UserID")) === String(userID))
    .map((peer) => ({ name: jstr(jget(peer, "HostName")) ?? jstr(jget(peer, "OS")) ?? "폰", online: jbool(jget(peer, "Online")) === true }));
  return {
    ...(backendState !== undefined ? { backendState } : {}),
    loggedIn: backendState === "Running",
    ...(dns !== undefined && dns !== "" ? { dnsName: dns } : {}),
    ...(login !== undefined ? { loginName: login } : {}),
    httpsEnabled: certDomains.length > 0,
    phones,
    ...(version !== undefined ? { version } : {}),
  };
}

export function parseServeStatus(json: JSONValue, port: number): ServeStatus {
  const funnel = Object.values(jobj(jget(json, "AllowFunnel")) ?? {}).some((value) => jbool(value) === true);
  let url: string | undefined;
  for (const [hostPort, site] of Object.entries(jobj(jget(json, "Web")) ?? {})) {
    for (const handler of Object.values(jobj(jget(site, "Handlers")) ?? {})) {
      const proxy = jstr(jget(handler, "Proxy")) ?? "";
      if (!/^(http:\/\/)?(127\.0\.0\.1|localhost):\d+\/?$/.test(proxy) || !proxy.includes(`:${port}`)) continue;
      const [host, servePort] = hostPort.split(":");
      url = servePort === undefined || servePort === "443" ? `https://${host}` : `https://${host}:${servePort}`;
    }
  }
  return { configured: url !== undefined, funnel, ...(url !== undefined ? { url } : {}) };
}

export class Tailscale {
  private cachedBinary: string | null | undefined;

  constructor(private readonly runner: CommandRunner = runCommand, private readonly pathEnv: () => string | undefined = () => process.env.PATH) {}

  binary(): string | undefined {
    if (this.cachedBinary !== undefined) return this.cachedBinary ?? undefined;
    const fromPath = (this.pathEnv() ?? "").split(":").map((directory) => `${directory}/tailscale`).find((candidate) => existsSync(candidate));
    this.cachedBinary = CANDIDATES.find((candidate) => existsSync(candidate)) ?? fromPath ?? null;
    return this.cachedBinary ?? undefined;
  }

  async status(): Promise<TailscaleStatus> {
    const binary = this.binary();
    if (binary === undefined) return { installed: false, loggedIn: false, httpsEnabled: false, phones: [] };
    const result = await this.runner(binary, ["status", "--json"]);
    try {
      return { installed: true, ...parseStatus(JSON.parse(result.stdout) as JSONValue) };
    } catch {
      return { installed: true, loggedIn: false, httpsEnabled: false, phones: [], error: (result.stderr || result.stdout).trim().slice(0, 300) };
    }
  }

  async serveStatus(port: number): Promise<ServeStatus> {
    const binary = this.binary();
    if (binary === undefined) return { configured: false, funnel: false };
    const result = await this.runner(binary, ["serve", "status", "--json"]);
    try {
      return parseServeStatus(JSON.parse(result.stdout || "{}") as JSONValue, port);
    } catch {
      return { configured: false, funnel: false };
    }
  }

  /** 온보딩 3단계 — 앱이 명령을 실행하고 결과를 확인한다 */
  async registerServe(port: number): Promise<{ ok: boolean; output: string; status: ServeStatus }> {
    const binary = this.binary();
    if (binary === undefined) return { ok: false, output: "Tailscale 이 설치돼 있지 않습니다.", status: { configured: false, funnel: false } };
    const result = await this.runner(binary, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    const status = await this.serveStatus(port);
    return { ok: result.code === 0 && status.configured, output: `${result.stdout}${result.stderr}`.trim(), status };
  }
}
