import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationReducer, newConversationModel } from "../../shared/src/session/conversation.ts";
import type { ServerMessage, SessionView } from "../../shared/src/protocol.ts";
import { defaultSettings } from "../../shared/src/settings.ts";
import { ClaudeSessionRegistry } from "../src/claude/registry.ts";
import { parseEnvironmentDump } from "../src/claude/shell-environment.ts";
import { signalUntilExit } from "../src/claude/termination.ts";
import { Notifier } from "../src/push/notifier.ts";
import { base64url, encryptPayload, fromBase64url, generateVapidKeys, vapidAuthorization } from "../src/push/web-push.ts";
import { gate, type GateInput } from "../src/security.ts";
import { SessionChannel } from "../src/session/channel.ts";
import { QUIT_RESUME, SleepWatch, pickInterrupted } from "../src/session/auto-continue.ts";
import { extendOptions } from "../src/session/extensions.ts";
import { sessionEnvironment, sessionOptions } from "../src/session/options.ts";
import { DeviceStore } from "../src/stores.ts";
import { parseServeStatus, parseStatus, Tailscale } from "../src/tailscale.ts";
import { pdfPageCount, safeFileName, sniffImage, Uploads } from "../src/uploads.ts";

const TOKEN = "a".repeat(64);

function check(headers: Record<string, string>, overrides: Partial<GateInput> = {}) {
  return gate({
    method: "GET", path: "/api/sessions", headers: new Headers(headers), allowedLogins: ["me@example.com"],
    allowLocalhost: true, funnelOn: false, localToken: TOKEN, trustedHosts: ["mac.tail1234.ts.net"], ...overrides,
  });
}

describe("요청 문지기", () => {
  test("모르는 호스트는 막는다 — DNS 리바인딩", () => {
    expect(check({ host: "evil.example:47615" }).ok).toBe(false);
  });

  test("serve 로 온 요청은 허용 목록의 로그인만", () => {
    expect(check({ host: "mac.tail1234.ts.net", "tailscale-user-login": "me@example.com" })).toEqual({ ok: true, viaServe: true, login: "me@example.com" });
    expect(check({ host: "mac.tail1234.ts.net", "tailscale-user-login": "other@example.com" }).ok).toBe(false);
    // 태그 기기는 로그인 헤더가 없다
    expect(check({ host: "mac.tail1234.ts.net" }).ok).toBe(false);
    // Host 를 127.0.0.1 로 바꿔 넘겨도 X-Forwarded-For 가 serve 를 알린다
    expect(check({ host: "127.0.0.1:47615", "x-forwarded-for": "100.64.0.2" }).ok).toBe(false);
  });

  test("Funnel 이 켜져 있으면 serve 요청은 모두 막는다", () => {
    expect(check({ host: "mac.tail1234.ts.net", "tailscale-user-login": "me@example.com" }, { funnelOn: true }).ok).toBe(false);
  });

  test("바로 온 로컬 요청은 설정을 따른다", () => {
    expect(check({ host: "127.0.0.1:47615" }).ok).toBe(true);
    expect(check({ host: "127.0.0.1:47615" }, { allowLocalhost: false }).ok).toBe(false);
  });

  test("상태를 바꾸는 요청은 자기 출처만 — serve 가 Host 를 바꿔도 이 Mac 의 이름은 믿는다", () => {
    expect(check({ host: "127.0.0.1:47615", origin: "https://evil.example" }, { method: "POST" }).ok).toBe(false);
    expect(check({ host: "127.0.0.1:47615", origin: "http://127.0.0.1:47615" }, { method: "POST" }).ok).toBe(true);
    expect(check({ host: "127.0.0.1:47615", origin: "https://mac.tail1234.ts.net", "tailscale-user-login": "me@example.com" }, { upgrade: true }).ok).toBe(true);
  });

  test("로컬 API 는 토큰과 바로 온 요청만", () => {
    expect(check({ host: "127.0.0.1:47615", "x-light-token": TOKEN }, { path: "/local/status" }).ok).toBe(true);
    expect(check({ host: "127.0.0.1:47615", "x-light-token": "b".repeat(64) }, { path: "/local/status" }).ok).toBe(false);
    expect(check({ host: "mac.tail1234.ts.net", "tailscale-user-login": "me@example.com", "x-light-token": TOKEN }, { path: "/local/status" }).ok).toBe(false);
  });
});

/** 받는 브라우저처럼 푼다(RFC 8291) */
async function decrypt(body: Uint8Array, userPrivate: CryptoKey, userPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, userPrivate, 256));
  const hkdf = async (saltBytes: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltBytes, info }, key, length * 8));
  };
  const text = new TextEncoder();
  const info = new Uint8Array([...text.encode("WebPush: info\0"), ...userPublic, ...serverPublic]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(plain.at(-1)).toBe(0x02);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("웹 푸시", () => {
  test("aes128gcm 본문을 받는 쪽 키로 풀 수 있다", async () => {
    const user = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const userPublic = new Uint8Array(await crypto.subtle.exportKey("raw", user.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPayload({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: base64url(userPublic), auth: base64url(auth) } }, new TextEncoder().encode("{\"title\":\"승인 요청\"}"));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(body, user.privateKey, userPublic, auth)).toBe("{\"title\":\"승인 요청\"}");
  });

  test("VAPID JWT 는 공개 키로 검증되고 aud 는 푸시 서비스 출처다", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization("https://web.push.apple.com/QW1hYm/abc", keys, "https://mac.tail1234.ts.net", 1_800_000_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, publicKey] = match!;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(claims!)));
    expect(parsed).toEqual({ aud: "https://web.push.apple.com", exp: 1_800_000_000 + 12 * 3600, sub: "https://mac.tail1234.ts.net" });
    const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature!), new TextEncoder().encode(`${head}.${claims}`));
    expect(valid).toBe(true);
  });

  test("보고 있는 기기에는 보내지 않고 410 은 구독을 지운다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "light-push-"));
    const devices = new DeviceStore(join(directory, "devices.json"));
    const user = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", user.publicKey)));
    const keys = { p256dh, auth: base64url(crypto.getRandomValues(new Uint8Array(16))) };
    devices.touch("phone-0001", { subscription: { endpoint: "https://push.example/phone", keys } });
    devices.touch("ipad-00001", { subscription: { endpoint: "https://push.example/ipad", keys } });
    const hits: string[] = [];
    const notifier = new Notifier({
      devices, settings: defaultSettings, vapid: await generateVapidKeys(), pushLog: join(directory, "push.jsonl"),
      fetcher: async (url) => {
        hits.push(url);
        return new Response("", { status: url.endsWith("ipad") ? 410 : 201 });
      },
    });
    notifier.setViewing("phone-0001", "s1");
    expect((await notifier.notify({ kind: "permission", sessionId: "s1", project: "p", body: "Bash: ls" })).sent).toBe(0);
    expect(hits).toEqual(["https://push.example/ipad"]);
    expect(devices.get("ipad-00001")?.subscription).toBeUndefined();
    expect(devices.get("ipad-00001")?.expiredAt).toBeNumber();
    hits.length = 0;
    expect((await notifier.notify({ kind: "permission", sessionId: "s2", project: "p", body: "Bash: ls" })).sent).toBe(1);
    expect(hits).toEqual(["https://push.example/phone"]);
    expect(readFileSync(join(directory, "push.jsonl"), "utf8").split("\n").filter(Boolean).length).toBe(2);
  });

  test("턴 완료는 요약을 기다렸다가 쓴다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "light-push-"));
    const devices = new DeviceStore(join(directory, "devices.json"));
    const sent: string[] = [];
    const notifier = new Notifier({ devices, settings: defaultSettings, vapid: await generateVapidKeys(), pushLog: join(directory, "push.jsonl"), summaryWaitMs: 200 });
    const original = notifier.notify.bind(notifier);
    notifier.notify = async (request) => {
      sent.push(request.body);
      return original(request);
    };
    let summary: string | undefined;
    notifier.turnDone({ sessionId: "s", project: "p", summary: () => summary, fallback: () => "마지막 줄", stillIdle: () => true }, 10);
    await Bun.sleep(30);
    summary = "테스트 3개를 고쳤습니다";
    await Bun.sleep(40);
    expect(sent).toEqual(["테스트 3개를 고쳤습니다"]);
  });
});

describe("동기화 통로", () => {
  function setup() {
    const model = newConversationModel();
    const view = { lifecycle: "idle" } as unknown as SessionView;
    const channel = new SessionChannel("s1", () => ({ model, view, cwd: "/p" }));
    return { model, channel };
  }

  test("처음 구독은 스냅샷, 바뀐 항목만 패치, 마지막 순번 다음부터 다시 받는다", () => {
    const { model, channel } = setup();
    const first: ServerMessage[] = [];
    channel.subscribe({ send: (message) => first.push(message) });
    expect(first[0]?.type).toBe("snapshot");
    ConversationReducer.apply({ kind: "localUser", id: "u1", text: "안녕" }, model);
    channel.flush();
    ConversationReducer.apply({ kind: "localUser", id: "u2", text: "둘째" }, model);
    channel.flush();
    const patches = first.filter((message) => message.type === "patch");
    expect(patches.map((message) => message.type === "patch" && message.upserts.map((upsert) => upsert.index))).toEqual([[0], [1]]);
    const epoch = first[0]?.type === "snapshot" ? first[0].epoch : "";
    const resumed: ServerMessage[] = [];
    channel.subscribe({ send: (message) => resumed.push(message) }, epoch, 1);
    expect(resumed.map((message) => message.type === "patch" && message.seq)).toEqual([2]);
    const stale: ServerMessage[] = [];
    channel.subscribe({ send: (message) => stale.push(message) }, "other", 1);
    expect(stale[0]?.type).toBe("snapshot");
  });

  test("앞부분 나눠 받기", () => {
    const { model, channel } = setup();
    for (let index = 0; index < 250; index += 1) ConversationReducer.apply({ kind: "localUser", id: `u${index}`, text: `m${index}` }, model);
    const snapshot = channel.snapshot();
    expect(snapshot.type === "snapshot" && [snapshot.firstIndex, snapshot.items.length]).toEqual([100, 150]);
    const page = channel.page(100, 60);
    expect([page.firstIndex, page.items.length, page.items[0]?.text]).toEqual([40, 60, "m40"]);
  });
});

describe("CLI 레지스트리", () => {
  test("pid 재사용은 프로세스 시작 시각으로 거른다", () => {
    const record = ClaudeSessionRegistry.parse(JSON.stringify({ pid: 4242, sessionId: "s", cwd: "/p", procStart: "Thu Oct 22 08:07:26 2026", status: "busy" }))!;
    const start = Date.UTC(2026, 9, 22, 8, 7, 26);
    expect(ClaudeSessionRegistry.isLive(record, start)).toBe(true);
    expect(ClaudeSessionRegistry.isLive(record, start + 60_000)).toBe(false);
    expect(ClaudeSessionRegistry.isLive(record, undefined)).toBe(false);
    expect(ClaudeSessionRegistry.isRecordFile("94629.bb35.key")).toBe(false);
  });

  test("가져오기는 busy 면 SIGINT 부터, 죽지 않으면 SIGKILL 까지 — 그 pid 하나에만", async () => {
    const sent: string[] = [];
    let alive = true;
    let clock = 0;
    const exited = await signalUntilExit(777, true, {
      send: (pid, signal) => {
        sent.push(`${pid}:${signal}`);
        if (signal === "SIGKILL") alive = false;
      },
      sleep: async (ms) => { clock += ms; },
      isProcessAlive: () => alive,
      now: () => clock,
    });
    expect(exited).toBe(true);
    expect(sent).toEqual(["777:SIGINT", "777:SIGTERM", "777:SIGKILL"]);
  });
});

describe("세션 기동 옵션", () => {
  test("프리셋에 덧붙이고, 설정 파일을 읽고, 백그라운드 작업을 살리는 선언을 한다", () => {
    const options = sessionOptions({ cwd: "/p", sessionId: "id", permissionMode: "bypassPermissions" });
    // 기록하지 않는다 — 터미널과 오가는 세션이 지금 띄운 쪽의 프롬프트로 돈다(실측)
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", snapshot: false, append: expect.stringContaining("! <command>") });
    expect(options.enableFileCheckpointing).toBe(true);
    expect(options.mcpServers).toBeUndefined();
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.perTaskStopAffordance).toBe(true);
    // bypass 는 늘 고를 수 있다 — 띄울 때부터 열어 두어야 도중에 바꿀 수 있다
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    // 서브에이전트의 글·생각도 받는다
    expect(options.forwardSubagentText).toBe(true);
    expect(options.extraArgs).toEqual({ "thinking-display": "summarized" });
    expect(options.settings).toBeUndefined();
  });

  test("노력도·빠른 모드·막은 MCP 서버를 플래그 층 하나에 싣는다", () => {
    const options = sessionOptions({ cwd: "/p", effort: "xhigh", fastMode: true, disabledMcpServers: ["fresh"], thinkingDisplay: "omitted" });
    expect(options.settings).toEqual({ disabledMcpjsonServers: ["fresh"], effortLevel: "xhigh", fastMode: true });
    expect(options.extraArgs).toEqual({ "thinking-display": "omitted" });
    expect(sessionOptions({ cwd: "/p", fastMode: false, disabledMcpServers: [] }).settings).toBeUndefined();
  });

  test("구독으로 쓰면 셸의 API 키를 넘기지 않고, 데몬을 띄운 쪽의 표식도 넘기지 않는다", () => {
    const environment = sessionEnvironment({
      PATH: "/bin", ANTHROPIC_API_KEY: "sk", CLAUDECODE: "1", LIGHT_HOME: "/x", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_PID: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_EFFORT: "max", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9",
    }, "subscription");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.CLAUDECODE).toBeUndefined();
    expect(environment.LIGHT_HOME).toBeUndefined();
    for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_EFFORT"]) expect(environment[key]).toBeUndefined();
    // 사람이 셸에 둔 claude 설정은 그대로
    expect(environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("9");
    expect(environment.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe("1");
    expect(environment.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS).toBe("0");
    expect(environment.CLAUDE_CODE_PLUGIN_DIR_WATCH).toBe("1");
    expect(sessionEnvironment({ ANTHROPIC_API_KEY: "sk" }, "apiKey").ANTHROPIC_API_KEY).toBe("sk");
  });

  test("턴 도구·Bash 훅을 확장 하나의 규칙으로 합친다 — 프롬프트는 순서대로 잇고 같은 MCP 이름은 던진다", async () => {
    const options = sessionOptions({ cwd: "/p", bashTimeouts: { defaultMs: 1000, maxMs: 2000 }, turnTools: { seed: [] } });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["turn"]);
    const append = (options.systemPrompt as { append: string }).append;
    expect(append.indexOf("phone")).toBeLessThan(append.indexOf("Bash timeouts"));
    expect(append.indexOf("Bash timeouts")).toBeLessThan(append.indexOf("mcp__turn__update_plan"));
    // Bash 한도·턴 도구 자동 허용
    const hooks = options.hooks?.PreToolUse ?? [];
    expect(hooks.length).toBe(2);
    const decisions = await Promise.all(hooks.map((matcher) => matcher.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "mcp__turn__wrap_up", tool_input: {} } as never, undefined, { signal: new AbortController().signal })));
    expect(decisions).toContainEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "light 의 도구입니다." } });
    expect(() => extendOptions({ mcpServers: { turn: { type: "stdio", command: "x" } } }, [{ mcpServers: { turn: { type: "stdio", command: "y" } } }])).toThrow("이미 실린 MCP 서버");
  });

  test("로그인 셸 env 덤프", () => {
    expect(parseEnvironmentDump("motd\n__LIGHT_SESSION_ENV__PATH=/a:/b\0SHLVL=2\0HOME=/Users/x\0")).toEqual({ PATH: "/a:/b", HOME: "/Users/x" });
  });
});

describe("자동 이어 가기", () => {
  test("끊긴 턴은 하루 안의 최근 넷만 이어 간다", () => {
    const now = 10 * QUIT_RESUME.withinMs;
    const turns = [1, 2, 3, 4, 5].map((minutes) => ({ id: `s${minutes}`, at: now - minutes * 60_000 })).concat([{ id: "old", at: now - QUIT_RESUME.withinMs - 1 }]);
    const { resume, dismiss } = pickInterrupted(turns, now);
    expect(resume.map((turn) => turn.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(dismiss.map((turn) => turn.id)).toEqual(["s5", "old"]);
  });

  test("잠들었다 깨어난 뒤 60초 동안 조용한 턴만 이어 간다", () => {
    let clock = 0;
    const continued: string[] = [];
    const target = (id: string, started: number | undefined, revision: () => number, waiting = false) => ({
      id, turnStartedAt: () => started, revision, waiting: () => waiting, continueAfterSleep: () => continued.push(id),
    });
    let busyRevision = 1;
    const watch = new SleepWatch({
      now: () => clock,
      sessions: () => [target("quiet", 0, () => 1), target("busy", 0, () => busyRevision), target("waiting", 0, () => 1, true), target("idle", undefined, () => 1), target("later", 50_000, () => 1)],
    });
    watch.tick(0);
    watch.tick(5_000);
    // 40초 넘게 틱이 비었다 — 잠들었다 깨어났다. 그 뒤로는 5초마다
    watch.tick(45_000);
    busyRevision = 2;
    for (let at = 50_000; at < 105_000; at += 5_000) watch.tick(at);
    expect(continued).toEqual([]);
    watch.tick(105_000);
    expect(continued).toEqual(["quiet"]);
    // 한 번 이어 갔으면 60초 안에는 다시 하지 않는다
    watch.tick(110_000);
    expect(continued).toEqual(["quiet"]);
  });
});

describe("첨부", () => {
  test("PDF 쪽 수 — 압축하지 않은 쪽 객체만 센다", () => {
    const text = (body: string) => new TextEncoder().encode(body);
    expect(pdfPageCount(text("%PDF-1.4 << /Type /Pages /Kids [3 0 R] >> << /Type /Page >> << /Type/Page /Parent 2 0 R >>"))).toBe(2);
    expect(pdfPageCount(text("%PDF-1.7 << /Type /ObjStm >>"))).toBe(0);
  });

  test("이름은 다시 짓고 이미지는 머리 바이트로 판정한다", async () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("스크린샷 2026-10-22.png")).toBe("스크린샷 2026-10-22.png");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("<svg"))).toBeUndefined();
  });

  test("파일은 세션 폴더로 옮겨 경로로, 이미지는 base64 블록으로", async () => {
    const root = mkdtempSync(join(tmpdir(), "light-uploads-"));
    const uploads = new Uploads(root);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const image = await uploads.save(png.buffer, { name: "shot.png", kind: "image", mediaType: "image/heic" });
    expect(image.mediaType).toBe("image/png");
    const file = await uploads.save(new TextEncoder().encode("log").buffer as ArrayBuffer, { name: "crash.log", kind: "file" });
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const consumed = uploads.consume([image.id, file.id], sessionId);
    expect(consumed.images[0]?.data).toBe(Buffer.from(png).toString("base64"));
    expect(consumed.files[0]!.startsWith(join(root, sessionId))).toBe(true);
    expect(existsSync(consumed.files[0]!)).toBe(true);
    expect(() => uploads.consume([image.id], sessionId)).toThrow();
    await expect(uploads.save(new TextEncoder().encode("not an image").buffer as ArrayBuffer, { name: "x.png", kind: "image" })).rejects.toThrow();
  });
});

describe("Tailscale", () => {
  test("상태와 serve·Funnel 을 읽는다", () => {
    const status = parseStatus({
      BackendState: "Running", Version: "1.90.0", CertDomains: ["mac.tail1234.ts.net"],
      Self: { DNSName: "mac.tail1234.ts.net.", UserID: 7 }, User: { "7": { LoginName: "me@example.com" } },
      Peer: {
        a: { HostName: "jin-iphone", OS: "iOS", UserID: 7, Online: true },
        b: { HostName: "ipad", OS: "iOS", UserID: 7, Online: false },
        c: { HostName: "other-iphone", OS: "iOS", UserID: 9, Online: true },
        d: { HostName: "server", OS: "linux", UserID: 7, Online: true },
      },
    });
    // 폰은 이 Mac 소유자의 iOS·Android 기기만 센다 — 남의 폰과 서버는 빼고 꺼진 폰은 꺼졌다고 둔다
    expect(status).toEqual({
      backendState: "Running", loggedIn: true, dnsName: "mac.tail1234.ts.net", loginName: "me@example.com", httpsEnabled: true, version: "1.90.0",
      phones: [{ name: "jin-iphone", online: true }, { name: "ipad", online: false }],
    });
    const serve = parseServeStatus({
      TCP: { "443": { HTTPS: true } },
      Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47615" } } } },
      AllowFunnel: { "mac.tail1234.ts.net:443": true },
    }, 47615);
    expect(serve).toEqual({ configured: true, funnel: true, url: "https://mac.tail1234.ts.net" });
    expect(parseServeStatus({}, 47615)).toEqual({ configured: false, funnel: false });
  });

  test("데몬이 뜬 뒤에 설치한 Tailscale 도 다음에 잴 때 찾는다 — 시작하기 1단계가 그 순서다", async () => {
    const { writeFileSync } = await import("node:fs");
    const bin = mkdtempSync(join(tmpdir(), "light-tailscale-"));
    const calls: string[] = [];
    const tailscale = new Tailscale(async (command, args) => {
      calls.push(command);
      return { code: 0, stdout: args[0] === "status" ? JSON.stringify({ BackendState: "Running" }) : "{}", stderr: "" };
    }, () => `${bin}:/usr/bin`, []);
    expect(await tailscale.status()).toMatchObject({ installed: false });
    writeFileSync(join(bin, "tailscale"), "");
    expect(await tailscale.status()).toMatchObject({ installed: true, loggedIn: true });
    expect(calls).toEqual([join(bin, "tailscale")]);
  });

  test("터미널 밖에서도 Tailscale.app 을 CLI 로 띄운다 — 로그인 항목으로 뜬 데몬에는 TERM 이 없다", async () => {
    const { chmodSync, writeFileSync } = await import("node:fs");
    const bin = mkdtempSync(join(tmpdir(), "light-tailscale-"));
    // Tailscale.app 처럼 CLI 신호가 없으면 GUI 로 뜨려다 실패한다
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh
[ "$TAILSCALE_BE_CLI" = 1 ] || { echo "The Tailscale GUI failed to start" >&2; exit 1; }
echo '{"BackendState":"Running"}'
`);
    chmodSync(join(bin, "tailscale"), 0o755);
    expect(await new Tailscale(undefined, () => bin, []).status()).toMatchObject({ installed: true, loggedIn: true });
  });
});

describe("터미널과 맞추기", () => {
  test("어느 설정에도 정한 기록이 없는 .mcp.json 서버만 끈다", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { pendingProjectMcpServers } = await import("../src/session/terminal-parity.ts");
    const home = mkdtempSync(join(tmpdir(), "light-home-"));
    const project = mkdtempSync(join(tmpdir(), "light-project-"));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { decided: {}, fresh: {} } }));
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["decided"] }));
    expect(pendingProjectMcpServers(project, home)).toEqual(["fresh"]);
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(pendingProjectMcpServers(project, home)).toEqual([]);
  });

  test("사고 표시는 설정의 showThinkingSummaries 를 따르고 뒤 층이 이긴다", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { thinkingDisplay } = await import("../src/session/terminal-parity.ts");
    const home = mkdtempSync(join(tmpdir(), "light-home-"));
    const project = mkdtempSync(join(tmpdir(), "light-project-"));
    expect(thinkingDisplay(home, project)).toBe("summarized");
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ showThinkingSummaries: false }));
    expect(thinkingDisplay(home, project)).toBe("omitted");
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ showThinkingSummaries: true }));
    expect(thinkingDisplay(home, project)).toBe("summarized");
  });

  test("Claude in Chrome 은 ~/.claude.json 의 기본값을 env 로 건넨다", async () => {
    const { writeFileSync } = await import("node:fs");
    const { chromeEnvironment } = await import("../src/session/terminal-parity.ts");
    const home = mkdtempSync(join(tmpdir(), "light-home-"));
    expect(chromeEnvironment(home)).toEqual({});
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    expect(chromeEnvironment(home)).toEqual({ CLAUDE_CODE_ENABLE_CFC: "1" });
  });
});

describe("Bash 한도를 터미널과 맞추기", () => {
  test("포그라운드는 터미널 기본값·상한으로, 백그라운드는 적힌 한도를 지운다", async () => {
    const { bashTimeoutParity, terminalBashTimeouts } = await import("../src/session/terminal-parity.ts");
    const home = mkdtempSync(join(tmpdir(), "light-home-"));
    const terminal = terminalBashTimeouts({}, home, home);
    expect(terminal).toEqual({ defaultMs: 120_000, maxMs: 600_000 });
    expect(bashTimeoutParity("Bash", { command: "ls" }, terminal)).toEqual({ command: "ls", timeout: 120_000 });
    expect(bashTimeoutParity("Bash", { command: "ls", timeout: 9_000_000 }, terminal)).toEqual({ command: "ls", timeout: 600_000 });
    expect(bashTimeoutParity("Bash", { command: "ls", timeout: 5_000 }, terminal)).toBeUndefined();
    expect(bashTimeoutParity("Bash", { command: "sleep 9", run_in_background: true, timeout: 3_000 }, terminal)).toEqual({ command: "sleep 9", run_in_background: true });
    expect(bashTimeoutParity("Read", { file_path: "/x" }, terminal)).toBeUndefined();
    expect(terminalBashTimeouts({ BASH_DEFAULT_TIMEOUT_MS: "900000" }, home, home)).toEqual({ defaultMs: 900_000, maxMs: 900_000 });
  });
});

describe("설정 저장", () => {
  test("준 키만 바꾸고 나머지는 지킨다, null 은 기본값으로 돌린다", async () => {
    const { SettingsStore } = await import("../src/stores.ts");
    const directory = mkdtempSync(join(tmpdir(), "light-settings-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ port: 47617, projectFolders: ["/p"], defaultModel: "haiku" }));
    const store = new SettingsStore(join(directory, "settings.json"));
    store.update({ allowedLogins: ["me@example.com"] });
    expect(store.current.port).toBe(47617);
    expect(store.current.projectFolders).toEqual(["/p"]);
    store.update({ defaultModel: null, unknownKey: 1 });
    expect(store.current.defaultModel).toBeUndefined();
    expect(store.current.allowedLogins).toEqual(["me@example.com"]);
    expect(() => store.update({ port: 80 })).toThrow();
    expect(new SettingsStore(join(directory, "settings.json")).current.port).toBe(47617);
  });
});
