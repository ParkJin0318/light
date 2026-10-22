/**
 * 요청 문지기. 데몬은 127.0.0.1 에만 바인드하고 밖에서는 tailscale serve 를 거쳐야만 들어온다.
 *
 * - Host: localhost·127.0.0.1·`*.ts.net` 만 받는다 — DNS 리바인딩으로 남의 도메인이 이 포트를 가리켜도 막힌다
 * - serve 로 온 요청(ts.net 호스트·`Tailscale-User-Login`·`X-Forwarded-For` 가 있다): serve 가 붙이는 `Tailscale-User-Login` 을
 *   허용 목록과 대조한다. 공유 노드로 들어온 다른 사용자와 태그 기기(헤더가 없다)는 막는다. Funnel 이 켜져 있으면 전부 막는다
 * - 바로 온 로컬 요청: 설정이 허용할 때만(이 Mac 의 브라우저). 같은 Mac 의 다른 프로세스는 헤더를 꾸밀 수 있지만
 *   그 프로세스는 이미 claude 를 직접 돌릴 수 있으므로 위협 모델 밖이다
 * - 상태를 바꾸는 요청과 WebSocket 은 Origin 이 자기 주소일 때만 — Mac 브라우저의 다른 사이트가 보내는 위조 요청을 막는다
 * - Mac 앱의 로컬 API(`/local/*`)는 바로 온 로컬 요청 + 데이터 폴더의 토큰(0600)
 */
import { timingSafeEqual } from "node:crypto";

export interface GateInput {
  method: string;
  path: string;
  headers: Headers;
  allowedLogins: readonly string[];
  allowLocalhost: boolean;
  funnelOn: boolean;
  localToken: string;
  /** 이 Mac 의 MagicDNS 이름 — serve 가 Host 를 127.0.0.1 로 바꿔 넘겨도 PWA 의 Origin 을 알아본다 */
  trustedHosts: readonly string[];
  /** WebSocket 업그레이드 */
  upgrade?: boolean;
}

export type GateResult =
  | { ok: true; viaServe: boolean; login?: string }
  | { ok: false; status: number; reason: string };

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `host:port` 에서 호스트만 */
function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1).toLowerCase();
  return (host.split(":")[0] ?? "").toLowerCase();
}

function isTailnetHost(name: string): boolean {
  return name.endsWith(".ts.net") && /^[a-z0-9.-]+$/.test(name);
}

function safeEqual(lhs: string, rhs: string): boolean {
  const a = Buffer.from(lhs);
  const b = Buffer.from(rhs);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function gate(input: GateInput): GateResult {
  const host = input.headers.get("host") ?? "";
  const name = hostName(host);
  const forwardedHost = input.headers.get("x-forwarded-host");
  const login = input.headers.get("tailscale-user-login") ?? undefined;
  const viaServe = isTailnetHost(name) || login !== undefined || input.headers.has("x-forwarded-for")
    || (forwardedHost !== null && isTailnetHost(hostName(forwardedHost)));
  if (!LOCAL_HOSTS.has(name) && !isTailnetHost(name)) return { ok: false, status: 421, reason: "모르는 호스트입니다." };

  if (input.path.startsWith("/local/")) {
    if (viaServe) return { ok: false, status: 403, reason: "로컬 API 는 이 Mac 에서만 씁니다." };
    const token = input.headers.get("x-light-token") ?? "";
    if (input.localToken === "" || !safeEqual(token, input.localToken)) return { ok: false, status: 401, reason: "로컬 토큰이 맞지 않습니다." };
    return { ok: true, viaServe: false };
  }

  if (viaServe) {
    if (input.funnelOn) return { ok: false, status: 403, reason: "Tailscale Funnel 이 켜져 있어 접속을 막았습니다. Funnel 을 끄십시오." };
    if (login === undefined) return { ok: false, status: 403, reason: "tailnet 로그인이 없는 기기(태그 기기)는 접속할 수 없습니다." };
    const allowed = input.allowedLogins.some((candidate) => candidate.toLowerCase() === login.toLowerCase());
    if (!allowed) return { ok: false, status: 403, reason: `${login} 은 이 Mac 에 접속할 수 없습니다.` };
  } else if (!input.allowLocalhost) {
    return { ok: false, status: 403, reason: "이 Mac 에서 바로 여는 접속은 꺼져 있습니다." };
  }

  const mutating = input.upgrade === true || !["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase());
  if (mutating) {
    const origin = input.headers.get("origin");
    // 브라우저 밖(서비스 워커의 일부 요청·curl)은 Origin 이 없다 — 브라우저는 교차 출처 요청에 늘 싣는다
    if (origin !== null && !sameOrigin(origin, [host, forwardedHost ?? "", ...input.trustedHosts])) {
      return { ok: false, status: 403, reason: "다른 출처의 요청입니다." };
    }
  }
  return { ok: true, viaServe, ...(login !== undefined ? { login } : {}) };
}

function sameOrigin(origin: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return hosts.some((host) => host !== "" && parsed.host.toLowerCase() === host.toLowerCase());
}
