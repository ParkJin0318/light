/**
 * HTTP·WS API와 PWA 정적 파일. 127.0.0.1 에만 바인드한다 — 밖에서는 tailscale serve 를 거쳐야만 들어온다.
 * 모든 요청은 먼저 `gate` 를 지난다. Mac 앱이 쓰는 로컬 API 는 `/local/*` 이다(`local-api.ts`)
 */
import type { Server, ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import {
  clientMessageSchema, newSessionSchema, pushSubscriptionSchema, resumeSchema, rewindSchema, sessionPatchSchema, ATTACHMENT_LIMITS,
  type ClientMessage, type ServerMessage,
} from "../../shared/src/protocol.ts";
import { errorText, log } from "./log.ts";
import type { Notifier } from "./push/notifier.ts";
import type { VapidKeys } from "./push/web-push.ts";
import { gate } from "./security.ts";
import type { Subscriber } from "./session/channel.ts";
import { SessionError, type LiveSession } from "./session/live-session.ts";
import type { SessionManager } from "./session/manager.ts";
import type { DeviceStore, SettingsStore } from "./stores.ts";
import { UploadError, type Uploads } from "./uploads.ts";

export const VERSION = "0.1.0";

export interface ServerContext {
  settings: SettingsStore;
  manager: SessionManager;
  devices: DeviceStore;
  uploads: Uploads;
  notifier: Notifier;
  vapid: VapidKeys;
  pwaDist: string;
  localToken: string;
  hostId: string;
  /** 데몬이 시작을 거부했다(Funnel 이 켜져 있다 등) — 로컬 API 만 답한다 */
  blocked: () => string | undefined;
  funnelOn: () => boolean;
  trustedHosts: () => string[];
  local: (request: Request, url: URL) => Promise<Response>;
}

interface SocketData {
  deviceId: string;
  /** 이 연결의 표식 — 「보고 있음」 임차의 주인 */
  socketId: string;
  /** 구독한 세션 객체를 함께 쥔다 — 관리자가 그 세션을 갈았어도 바로 그 통로에서 뗀다 */
  subscriptions: Map<string, { session: LiveSession; subscriber: Subscriber }>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

const DEVICE_ID = /^[A-Za-z0-9_-]{8,100}$/;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function failure(error: unknown): Response {
  if (error instanceof SessionError || error instanceof UploadError) return json({ error: error.message }, error.status);
  if (error instanceof Error && error.name === "ZodError") return json({ error: "요청 모양이 맞지 않습니다." }, 400);
  log("error", "request failed", { error: errorText(error) });
  return json({ error: errorText(error) }, 500);
}

export function startServer(context: ServerContext, port: number): Server<SocketData> {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  context.manager.onSessions((sessions) => {
    const message = JSON.stringify({ type: "sessions", sessions } satisfies ServerMessage);
    for (const socket of sockets) socket.send(message);
  });

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    async fetch(request, server) {
      const url = new URL(request.url);
      const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      const settings = context.settings.current;
      const verdict = gate({
        method: request.method, path: url.pathname, headers: request.headers, upgrade,
        allowedLogins: settings.allowedLogins, allowLocalhost: settings.allowLocalhost, funnelOn: context.funnelOn(),
        localToken: context.localToken, trustedHosts: context.trustedHosts(),
      });
      if (!verdict.ok) return json({ error: verdict.reason }, verdict.status);
      if (url.pathname.startsWith("/local/")) return context.local(request, url);
      const blocked = context.blocked();
      if (blocked !== undefined) return json({ error: blocked }, 503);

      if (url.pathname === "/api/stream") {
        const deviceId = url.searchParams.get("deviceId") ?? "";
        if (!DEVICE_ID.test(deviceId)) return json({ error: "기기 id 가 없습니다." }, 400);
        context.devices.touch(deviceId, {
          ...(verdict.login !== undefined ? { login: verdict.login } : {}),
          ...(url.searchParams.get("installed") === "1" ? { installed: true } : {}),
          label: deviceLabel(request.headers.get("user-agent") ?? ""),
        });
        if (server.upgrade(request, { data: { deviceId, socketId: crypto.randomUUID(), subscriptions: new Map() } })) return undefined;
        return json({ error: "WebSocket 업그레이드에 실패했습니다." }, 400);
      }
      if (url.pathname.startsWith("/api/")) {
        try {
          return await api(context, request, url, verdict.login);
        } catch (error) {
          return failure(error);
        }
      }
      return serveStatic(context.pwaDist, url.pathname);
    },
    websocket: {
      idleTimeout: 75,
      maxPayloadLength: 1024 * 1024,
      open(socket) {
        sockets.add(socket);
        sendTo(socket, { type: "welcome", hostId: context.hostId, version: VERSION });
        sendTo(socket, { type: "sessions", sessions: context.manager.summaries() });
      },
      async message(socket, raw) {
        let message: ClientMessage;
        try {
          message = clientMessageSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
        } catch {
          sendTo(socket, { type: "error", message: "메시지 모양이 맞지 않습니다." });
          return;
        }
        await handleSocketMessage(context, socket, message);
      },
      close(socket) {
        sockets.delete(socket);
        for (const { session, subscriber } of socket.data.subscriptions.values()) session.channel.unsubscribe(subscriber);
        socket.data.subscriptions.clear();
        context.notifier.releaseViewing(socket.data.deviceId, socket.data.socketId);
      },
    },
  });
  return server;
}

function sendTo(socket: ServerWebSocket<SocketData>, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

/** 큰 백로그가 쌓인 소켓은 끊는다 — 기기가 다시 붙어 마지막 순번부터 받는다 */
const MAX_BUFFERED = 8 * 1024 * 1024;

function subscriberFor(socket: ServerWebSocket<SocketData>): Subscriber {
  return {
    send(message) {
      if (socket.getBufferedAmount() > MAX_BUFFERED) {
        socket.close(1013, "backpressure");
        return;
      }
      sendTo(socket, message);
    },
  };
}

/**
 * 보낸 메시지의 결과 — 같은 기기가 같은 id 로 다시 보내면(재전송) 다시 실행하지 않는다.
 * 아직 처리 중이면 다시 보낸 연결에도 결과를 준다. 실패는 쥐지 않는다 — 다시 보내면 다시 한다
 */
interface SendRecord {
  result?: ServerMessage;
  sockets: Set<ServerWebSocket<SocketData>>;
  at: number;
}

const sends = new Map<string, SendRecord>();
const SEND_MEMORY_MS = 10 * 60_000;

async function sendOnce(socket: ServerWebSocket<SocketData>, session: LiveSession, message: Extract<ClientMessage, { type: "send" }>): Promise<void> {
  const key = `${socket.data.deviceId}:${message.clientMessageId}`;
  const known = sends.get(key);
  if (known !== undefined) {
    if (known.result !== undefined) sendTo(socket, known.result);
    else known.sockets.add(socket);
    return;
  }
  const entry: SendRecord = { sockets: new Set([socket]), at: Date.now() };
  sends.set(key, entry);
  for (const [other, value] of sends) if (Date.now() - value.at > SEND_MEMORY_MS) sends.delete(other);
  let result: ServerMessage;
  try {
    const outcome = await session.send(message.text, message.attachments, message.mode, message.snippets);
    result = { type: "sendResult", clientMessageId: message.clientMessageId, ok: true, queued: outcome.queued };
    entry.result = result;
  } catch (error) {
    result = { type: "sendResult", clientMessageId: message.clientMessageId, ok: false, error: errorText(error) };
    sends.delete(key);
  }
  for (const target of entry.sockets) if (target.readyState === 1) sendTo(target, result);
}

async function handleSocketMessage(context: ServerContext, socket: ServerWebSocket<SocketData>, message: ClientMessage): Promise<void> {
  const reply = (body: ServerMessage) => sendTo(socket, body);
  const session = "sessionId" in message && message.sessionId !== null ? context.manager.get(message.sessionId) : undefined;
  try {
    switch (message.type) {
      case "ping":
        reply({ type: "pong" });
        return;
      case "viewing":
        context.notifier.setViewing(socket.data.deviceId, message.sessionId, socket.data.socketId);
        if (message.sessionId !== null) context.notifier.cancel(message.sessionId);
        return;
      case "subscribe": {
        if (session === undefined) {
          reply({ type: "error", message: "세션을 찾지 못했습니다." });
          return;
        }
        const previous = socket.data.subscriptions.get(message.sessionId);
        if (previous !== undefined) previous.session.channel.unsubscribe(previous.subscriber);
        const subscriber = subscriberFor(socket);
        let target = session;
        socket.data.subscriptions.set(message.sessionId, { session: target, subscriber });
        await target.ensureLoaded();
        // 기다리는 사이 관리자가 그 세션을 갈았으면(정리·이어받기) 지금 것에 붙는다
        for (let attempt = 0; attempt < 3 && context.manager.sessions.get(message.sessionId) !== target; attempt += 1) {
          const current = context.manager.get(message.sessionId);
          if (current === undefined) break;
          target = current;
          await target.ensureLoaded();
        }
        // 기다리는 사이 다른 구독으로 갈았으면 이 구독은 버린다
        if (socket.data.subscriptions.get(message.sessionId)?.subscriber !== subscriber) return;
        socket.data.subscriptions.set(message.sessionId, { session: target, subscriber });
        target.channel.subscribe(subscriber, message.epoch, message.lastSeq);
        return;
      }
      case "unsubscribe": {
        const subscription = socket.data.subscriptions.get(message.sessionId);
        if (subscription !== undefined) subscription.session.channel.unsubscribe(subscription.subscriber);
        socket.data.subscriptions.delete(message.sessionId);
        return;
      }
      default:
        break;
    }
    if (session === undefined) throw new SessionError("세션을 찾지 못했습니다.", 404);
    switch (message.type) {
      case "send":
        await sendOnce(socket, session, message);
        return;
      case "interrupt":
        await session.interrupt();
        return;
      case "background":
        await session.background();
        return;
      case "respond": {
        const outcome = session.respond(message.requestId, message.answer);
        reply({
          type: "respondResult", requestId: message.requestId, ok: outcome === "ok",
          ...(outcome === "handled" ? { alreadyHandled: true } : {}), ...(outcome === "invalid" ? { error: "이 카드에 맞지 않는 답입니다." } : {}),
        });
        return;
      }
      case "setMode":
        await session.setPermissionMode(message.mode);
        return;
      case "setModel":
        await session.setModel(message.model);
        return;
      case "setEffort":
        await session.setEffort(message.effort);
        return;
      case "setFastMode":
        await session.setFastMode(message.on);
        return;
      case "stopTask":
        await session.stopTask(message.taskId);
        return;
      case "queueCancel":
        session.cancelQueued(message.queueId);
        return;
      case "queueSendNow":
        await session.sendQueuedNow(message.queueId);
        return;
    }
  } catch (error) {
    if (message.type === "send") {
      reply({ type: "sendResult", clientMessageId: message.clientMessageId, ok: false, error: errorText(error) });
    } else if (message.type === "respond") {
      reply({ type: "respondResult", requestId: message.requestId, ok: false, error: errorText(error) });
    } else {
      reply({ type: "error", message: errorText(error) });
    }
  }
}

async function api(context: ServerContext, request: Request, url: URL, login: string | undefined): Promise<Response> {
  const method = request.method.toUpperCase();
  const parts = url.pathname.split("/").filter((part) => part !== "").slice(1).map(decodeURIComponent);
  const deviceId = request.headers.get("x-light-device") ?? "";
  if (method === "GET" && parts[0] === "health") return json({ ok: true, version: VERSION, hostId: context.hostId });
  if (method === "GET" && parts[0] === "config") {
    const settings = context.settings.current;
    return json({
      version: VERSION, hostId: context.hostId, vapidPublicKey: context.vapid.publicKey, limits: ATTACHMENT_LIMITS,
      defaultPermissionMode: settings.defaultPermissionMode,
      defaultModel: settings.defaultModel ?? null, defaultEffort: settings.defaultEffort ?? null, ...(login !== undefined ? { login } : {}),
    });
  }
  if (method === "GET" && parts[0] === "projects") return json({ projects: context.manager.projects() });
  if (method === "GET" && parts[0] === "models") return json({ models: await context.manager.models() });
  if (parts[0] === "sessions") return sessionsAPI(context, request, method, parts.slice(1), url);
  if (method === "POST" && parts[0] === "uploads") {
    const kind = url.searchParams.get("kind") === "image" ? "image" : "file";
    const length = Number(request.headers.get("content-length") ?? "0");
    const limit = kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
    if (length > limit) return json({ error: `파일이 너무 큽니다(최대 ${Math.round(limit / 1024 / 1024)}MB).` }, 413);
    const info = await context.uploads.save(await request.arrayBuffer(), {
      kind, name: url.searchParams.get("name") ?? "file", mediaType: request.headers.get("content-type") ?? undefined,
    });
    return json(info);
  }
  if (method === "POST" && parts[0] === "push" && parts[1] === "subscriptions") {
    const body = pushSubscriptionSchema.parse(await request.json());
    const origin = request.headers.get("origin") ?? undefined;
    context.devices.touch(body.deviceId, {
      subscription: { endpoint: body.subscription.endpoint, keys: body.subscription.keys },
      ...(body.label !== undefined ? { label: body.label } : {}), ...(login !== undefined ? { login } : {}),
      ...(origin !== undefined ? { origin } : {}), expiredAt: undefined,
    });
    return json({ ok: true });
  }
  if (method === "POST" && parts[0] === "push" && parts[1] === "resubscribe") {
    // 서비스 워커의 pushsubscriptionchange — 기기 id 를 모르므로 옛 endpoint 로 찾는다
    const body = await request.json() as { oldEndpoint?: unknown; subscription?: unknown };
    const parsed = pushSubscriptionSchema.shape.subscription.safeParse(body.subscription);
    const device = context.devices.all().find((candidate) => typeof body.oldEndpoint === "string" && candidate.subscription?.endpoint === body.oldEndpoint);
    if (!parsed.success || device === undefined) return json({ ok: false }, 404);
    context.devices.patch(device.id, { subscription: { endpoint: parsed.data.endpoint, keys: parsed.data.keys }, expiredAt: undefined });
    return json({ ok: true });
  }
  if (method === "POST" && parts[0] === "push" && parts[1] === "ack") {
    const body = await request.json() as { pushId?: unknown; deviceId?: unknown };
    if (typeof body.pushId === "string" && typeof body.deviceId === "string") context.notifier.ack(body.pushId, body.deviceId);
    return json({ ok: true });
  }
  if (method === "POST" && parts[0] === "push" && parts[1] === "test") {
    if (!DEVICE_ID.test(deviceId)) return json({ error: "기기 id 가 없습니다." }, 400);
    const result = await context.notifier.notify({ kind: "test", sessionId: "", project: "light", body: "알림이 이 기기에 닿았습니다." }, deviceId);
    return json(result);
  }
  return json({ error: "없는 경로입니다." }, 404);
}

async function sessionsAPI(context: ServerContext, request: Request, method: string, parts: string[], url: URL): Promise<Response> {
  const manager = context.manager;
  if (parts.length === 0) {
    if (method === "GET") return json({ sessions: manager.summaries() });
    if (method === "POST") {
      const body = newSessionSchema.parse(await request.json());
      const session = await manager.create({
        cwd: body.cwd, prompt: body.prompt, attachments: body.attachments,
        ...(body.model !== undefined ? { model: body.model } : {}), ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
      });
      return json({ sessionId: session.id, summary: session.summary() });
    }
  }
  const [sessionId, action, extra] = parts;
  if (sessionId === undefined) return json({ error: "없는 경로입니다." }, 404);
  if (method === "PATCH" && action === undefined) {
    manager.patch(sessionId, sessionPatchSchema.parse(await request.json()));
    return json({ ok: true });
  }
  if (method === "POST" && action === "resume") {
    const body = resumeSchema.parse(await request.json().catch(() => ({})));
    const session = await manager.resume(sessionId, body.mode, body.confirmBusy ?? false);
    return json({ sessionId: session.id, summary: session.summary() });
  }
  if (method === "POST" && action === "release") return json({ command: await manager.release(sessionId) });
  const session = manager.get(sessionId);
  if (session === undefined) return json({ error: "세션을 찾지 못했습니다." }, 404);
  if (method === "GET" && action === "tasks" && extra !== undefined && parts[3] === "output") {
    return json(await session.taskOutput(extra));
  }
  if (method === "GET" && action === "rewind-points") return json({ points: await session.rewindPoints() });
  if (method === "POST" && action === "rewind") {
    const body = rewindSchema.parse(await request.json());
    return json(await session.rewind(body.pointId, body.scope, body.dryRun ?? false));
  }
  if (method === "GET" && action === "events") {
    await session.ensureLoaded();
    const before = Number(url.searchParams.get("before") ?? String(session.model.items.length));
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
    return json(session.channel.page(Number.isFinite(before) ? before : session.model.items.length, limit));
  }
  if (method === "GET" && action === "images" && extra !== undefined) {
    await session.ensureLoaded();
    const image = session.image(extra);
    if (image === undefined) return json({ error: "이미지가 없습니다." }, 404);
    return new Response(Buffer.from(image.data, "base64"), { headers: {
      "Content-Type": image.mediaType, "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  }
  return json({ error: "없는 경로입니다." }, 404);
}

function serveStatic(root: string, pathname: string): Response {
  const base = resolve(root);
  const relative = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  let path = resolve(base, relative);
  if (!path.startsWith(base)) return json({ error: "없는 경로입니다." }, 404);
  if (relative === "" || !existsSync(path) || statSync(path).isDirectory()) path = join(base, "index.html");
  if (!existsSync(path)) {
    return new Response("PWA 를 아직 빌드하지 않았습니다. `npm run build` 를 돌리십시오.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const extension = extname(path);
  const immutable = path.includes(`${join(base, "assets")}/`);
  const headers: Record<string, string> = {
    "Content-Type": MIME[extension] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (path.endsWith("sw.js")) headers["Service-Worker-Allowed"] = "/";
  if (extension === ".html") {
    headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
  }
  return new Response(Bun.file(path), { headers });
}

function deviceLabel(userAgent: string): string {
  if (/iPad/.test(userAgent)) return "iPad";
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/Macintosh/.test(userAgent)) return /Mobile/.test(userAgent) ? "iPad" : "Mac 브라우저";
  if (/Android/.test(userAgent)) return "Android";
  return "브라우저";
}
