/**
 * serve 경로 끝에서 끝까지 — 실제 데몬 프로세스를 띄우고, 가짜 tailscale CLI 와 serve 처럼 동작하는 프록시를 둔다.
 * 프록시는 Host 를 보존하고(또는 127.0.0.1 로 바꾸고) X-Forwarded-* 와 Tailscale-User-Login 을 붙이며 들어온 Tailscale-* 머리는 지운다.
 * claude 세션은 띄우지 않는다
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, Subprocess } from "bun";

const root = mkdtempSync(join(tmpdir(), "light-e2e-"));
const home = join(root, "home");
const state = join(root, "ts");
const bin = join(root, "bin");
const port = 48_000 + Math.floor(Math.random() * 1000);
let daemon: Subprocess | undefined;
let preserve: Server<undefined> | undefined;
let rewrite: Server<undefined> | undefined;
let token = "";

function proxy(mode: "preserve" | "rewrite"): Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers();
      for (const [key, value] of request.headers) if (!key.startsWith("tailscale-") && key !== "x-test-login") headers.set(key, value);
      const host = request.headers.get("host") ?? "";
      headers.set("host", mode === "rewrite" ? `127.0.0.1:${port}` : host);
      headers.set("x-forwarded-host", host);
      headers.set("x-forwarded-proto", "https");
      headers.set("x-forwarded-for", "100.64.0.2");
      const login = request.headers.get("x-test-login") ?? "me@example.com";
      if (login !== "tagged") headers.set("tailscale-user-login", login);
      const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: request.method, headers, ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
}

const local = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}/local/${path}`, { ...init, headers: { "X-Light-Token": token, ...(init.headers ?? {}) } });

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ port, prewarm: false }));
  writeFileSync(join(state, "status.json"), JSON.stringify({
    BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net.", UserID: 7 }, User: { "7": { LoginName: "me@example.com" } }, CertDomains: ["mac.tail1234.ts.net"],
  }));
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh
case "$1 $2" in
  "status --json") cat "${state}/status.json" ;;
  "serve status") cat "${state}/serve.json" 2>/dev/null || echo '{}' ;;
  "serve --bg") port=$(echo "$4" | sed 's/.*://'); printf '{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "$port" > "${state}/serve.json"; echo ok ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "tailscale"), 0o755);
  daemon = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts")], {
    env: { ...process.env, LIGHT_HOME: home, PATH: `${bin}:${process.env.PATH}`, LIGHT_CLAUDE_HOME: join(root, "claude") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      // 아직 뜨는 중
    }
    await Bun.sleep(100);
  }
  token = readFileSync(join(home, "local-token"), "utf8").trim();
  preserve = proxy("preserve");
  rewrite = proxy("rewrite");
});

afterAll(async () => {
  preserve?.stop(true);
  rewrite?.stop(true);
  daemon?.kill("SIGTERM");
  await daemon?.exited;
});

describe("serve 경로", () => {
  test("허용 로그인의 기본값은 이 Mac 의 소유자이고 다른 설정은 그대로다", async () => {
    const settings = await (await local("settings")).json() as { allowedLogins: string[]; port: number };
    expect(settings.allowedLogins).toEqual(["me@example.com"]);
    expect(settings.port).toBe(port);
  });

  test("serve 등록은 이 데몬 포트로 프록시를 걸고 PWA 주소를 낸다", async () => {
    const result = await (await local("serve", { method: "POST" })).json() as { ok: boolean; status: { url?: string } };
    expect(result.ok).toBe(true);
    expect(result.status.url).toBe("https://mac.tail1234.ts.net");
  });

  for (const mode of ["preserve", "rewrite"] as const) {
    test(`serve 로 온 요청 — 허용 목록·태그 기기·위조 머리·출처 (${mode === "preserve" ? "Host 보존" : "Host 를 127.0.0.1 로"})`, async () => {
      const base = `http://127.0.0.1:${(mode === "preserve" ? preserve : rewrite)!.port}`;
      const host = { Host: "mac.tail1234.ts.net" };
      expect((await fetch(`${base}/api/sessions`, { headers: host })).status).toBe(200);
      expect((await fetch(`${base}/api/sessions`, { headers: { ...host, "X-Test-Login": "other@example.com" } })).status).toBe(403);
      expect((await fetch(`${base}/api/sessions`, { headers: { ...host, "X-Test-Login": "tagged" } })).status).toBe(403);
      // 기기가 직접 붙인 Tailscale-User-Login 은 serve 가 지운다
      expect((await fetch(`${base}/api/sessions`, { headers: { ...host, "X-Test-Login": "tagged", "Tailscale-User-Login": "me@example.com" } })).status).toBe(403);
      const patch = (origin: string) => fetch(`${base}/api/sessions/none`, { method: "PATCH", headers: { ...host, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
      expect((await patch("https://mac.tail1234.ts.net")).status).toBe(404);
      expect((await patch("https://evil.example")).status).toBe(403);
      expect((await fetch(`${base}/local/settings`, { headers: { ...host, "X-Light-Token": token } })).status).toBe(403);
    });
  }

  test("Funnel 이 켜지면 데몬은 멈춤 상태가 되고 끄면 풀린다", async () => {
    const serve = JSON.parse(readFileSync(join(state, "serve.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(state, "serve.json"), JSON.stringify({ ...serve, AllowFunnel: { "mac.tail1234.ts.net:443": true } }));
    await local("network", { method: "POST" });
    expect((await fetch(`http://127.0.0.1:${preserve!.port}/api/sessions`, { headers: { Host: "mac.tail1234.ts.net" } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status).toBe(503);
    expect(JSON.parse(readFileSync(join(home, "status.json"), "utf8")).state).toBe("blocked");
    writeFileSync(join(state, "serve.json"), JSON.stringify(serve));
    await local("network", { method: "POST" });
    expect((await fetch(`http://127.0.0.1:${preserve!.port}/api/sessions`, { headers: { Host: "mac.tail1234.ts.net" } })).status).toBe(200);
  });
});
