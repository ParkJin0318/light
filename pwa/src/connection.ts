/**
 * 데몬과의 WebSocket. iOS 는 백그라운드 PWA 의 소켓을 끊는다 — 그것을 정상 흐름으로 본다.
 * 전경으로 돌아오면 바로 다시 붙고, 구독한 세션마다 마지막 순번 다음부터 받는다.
 * 보고 있는 세션은 45초 임차로 알린다 — 보는 동안 20초마다 갱신하고, 끊기면 만료돼 푸시가 다시 나간다
 */
import type { ClientAnswer, ClientMessage, ServerMessage } from "../../shared/src/protocol.ts";
import type { AttachedSnippet } from "../../shared/src/session/attachments.ts";
import { deviceId } from "./api.ts";
import { isStandalone } from "./push.ts";
import { applySessionMessage, getState, setState, toast, type AppState } from "./store.ts";

const PING_MS = 20_000;
const VIEWING_RENEW_MS = 20_000;
/** 이만큼 붙지 못하면 「Mac 에 닿지 않음」 */
const UNREACHABLE_AFTER_MS = 8_000;
/** 보낸 메시지의 답을 기다리는 시간 — 넘으면 실패로 보고 입력창에 남긴다 */
const SEND_TIMEOUT_MS = 15_000;
/** 카드 답의 결과를 기다리는 시간 — 넘으면 카드를 다시 누를 수 있게 푼다 */
const RESPOND_TIMEOUT_MS = 12_000;
/** 전경 복귀 때 살아 있는지 묻고 기다리는 시간 — iOS 는 죽은 소켓을 OPEN 으로 남긴다 */
const PROBE_TIMEOUT_MS = 2_500;
/** 붙는 중에서 멈춘 핸드셰이크를 끊는 시간 */
const CONNECT_TIMEOUT_MS = 6_000;

class Connection {
  private socket: WebSocket | undefined;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private viewingTimer: ReturnType<typeof setInterval> | undefined;
  private disconnectedAt: number | undefined;
  private lastPongAt = 0;
  private stateTimer: ReturnType<typeof setInterval> | undefined;
  private readonly subscribed = new Set<string>();
  private viewing: string | null = null;
  private readonly sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(message: ServerMessage) => void>();

  start(): void {
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // 전경 복귀 — 기다리지 않고 바로 다시 붙는다. 열려 있다고 해도 살아 있는지 물어본다
        if (this.socket === undefined || this.socket.readyState > WebSocket.OPEN) this.reconnectNow();
        else if (this.socket.readyState === WebSocket.OPEN) this.probe();
        this.sendViewing();
      } else {
        this.send({ type: "viewing", sessionId: null });
      }
    });
    window.addEventListener("online", () => this.reconnectNow());
    window.addEventListener("pageshow", () => this.reconnectNow());
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): void {
    if (this.socket !== undefined && this.socket.readyState <= WebSocket.OPEN) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // 홈 화면 앱으로 열었는지도 알린다 — Mac 온보딩이 「폰에 설치」를 그것으로 체크한다
    const socket = new WebSocket(`${protocol}//${location.host}/api/stream?deviceId=${encodeURIComponent(deviceId())}${isStandalone() ? "&installed=1" : ""}`);
    this.socket = socket;
    this.disconnectedAt ??= Date.now();
    setState((current) => ({ ...current, connection: this.connectionWhileDown() }));
    setTimeout(() => {
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
    }, CONNECT_TIMEOUT_MS);
    // 끊긴 동안 연결 표시를 갱신한다 — 오래 끊기면 「Mac 에 닿지 않음」
    this.stateTimer ??= setInterval(() => {
      if (this.disconnectedAt === undefined) return;
      const next = this.connectionWhileDown();
      if (getState().connection !== next) setState((current) => ({ ...current, connection: next }));
    }, 1_000);
    socket.onopen = () => {
      this.attempt = 0;
      this.disconnectedAt = undefined;
      this.lastPongAt = Date.now();
      setState((current) => ({ ...current, connection: "connected" }));
      for (const sessionId of this.subscribed) this.resubscribe(sessionId);
      this.sendViewing();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearInterval(this.pingTimer);
      this.disconnectedAt ??= Date.now();
      // 보내다 끊긴 카드 답은 닿았는지 모른다 — 카드를 다시 누를 수 있게 푼다(이미 처리됐으면 데몬이 처리됨으로 답한다)
      setState((current) => ({ ...current, connection: this.connectionWhileDown(), answers: withoutSending(current.answers) }));
      this.scheduleReconnect();
    };
  }

  private connectionWhileDown(): "connecting" | "reconnecting" | "unreachable" {
    if (!getState().sessionsLoaded && this.attempt === 0) return "connecting";
    return this.disconnectedAt !== undefined && Date.now() - this.disconnectedAt > UNREACHABLE_AFTER_MS ? "unreachable" : "reconnecting";
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(5_000, 400 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** 열려 있다는 소켓이 정말 살아 있는지 — 답이 없으면 끊고 다시 붙는다 */
  private probe(): void {
    const socket = this.socket;
    const askedAt = Date.now();
    this.send({ type: "ping" });
    setTimeout(() => {
      if (this.socket !== socket || this.lastPongAt >= askedAt) return;
      socket?.close();
      this.reconnectNow();
    }, PROBE_TIMEOUT_MS);
  }

  private reconnectNow(): void {
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "sessions":
        setState((current) => ({ ...current, sessions: message.sessions, sessionsLoaded: true }));
        break;
      case "snapshot":
      case "patch": {
        if (!this.subscribed.has(message.sessionId)) break;
        const { gap } = applySessionMessage(message);
        if (gap) this.resubscribe(message.sessionId);
        break;
      }
      case "sendResult": {
        clearTimeout(this.sendTimers.get(message.clientMessageId));
        this.sendTimers.delete(message.clientMessageId);
        setState((current) => {
          const outgoing = current.outbox[message.clientMessageId];
          if (outgoing === undefined) return current;
          const outbox = { ...current.outbox };
          if (message.ok) delete outbox[message.clientMessageId];
          else outbox[message.clientMessageId] = { ...outgoing, status: "failed", error: message.error ?? "보내지 못했습니다." };
          return { ...current, outbox };
        });
        if (message.ok && message.queued === true) toast("턴이 끝나면 보냅니다.");
        break;
      }
      case "respondResult":
        setState((current) => ({
          ...current,
          answers: { ...current.answers, [message.requestId]: message.ok ? "sending" : message.alreadyHandled === true ? "handled" : "error" },
        }));
        if (message.alreadyHandled === true) toast("다른 기기에서 이미 처리했습니다.");
        else if (!message.ok && message.error !== undefined) toast(message.error, { tone: "error" });
        break;
      case "error":
        toast(message.message, { tone: "error" });
        break;
      case "pong":
        this.lastPongAt = Date.now();
        break;
      case "welcome":
        break;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(message: ClientMessage): boolean {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  subscribe(sessionId: string): void {
    this.subscribed.add(sessionId);
    this.resubscribe(sessionId);
  }

  unsubscribe(sessionId: string): void {
    this.subscribed.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  private resubscribe(sessionId: string): void {
    const data = getState().data[sessionId];
    this.send({
      type: "subscribe", sessionId,
      ...(data?.epoch !== undefined ? { epoch: data.epoch, lastSeq: data.seq } : {}),
    });
  }

  /** 보고 있는 세션 — null 이면 아무것도 보지 않는다 */
  setViewing(sessionId: string | null): void {
    this.viewing = sessionId;
    this.sendViewing();
    clearInterval(this.viewingTimer);
    if (sessionId !== null) this.viewingTimer = setInterval(() => this.sendViewing(), VIEWING_RENEW_MS);
  }

  private sendViewing(): void {
    if (document.visibilityState !== "visible") return;
    this.send({ type: "viewing", sessionId: this.viewing });
  }

  /** 사람 메시지 — 답이 오지 않으면 입력창에 남기고 재전송을 준다 */
  /** 재전송은 같은 id 로 한다 — 데몬이 이미 받은 것이면 다시 실행하지 않고 그 결과를 준다 */
  sendMessage(sessionId: string, text: string, attachments: string[], mode: "queue" | "now" = "queue", retryOf?: string, snippets: AttachedSnippet[] = []): string {
    const clientMessageId = retryOf ?? crypto.randomUUID();
    clearTimeout(this.sendTimers.get(clientMessageId));
    const sent = this.send({ type: "send", sessionId, clientMessageId, text, attachments, snippets, mode });
    setState((current) => ({
      ...current,
      outbox: {
        ...current.outbox,
        [clientMessageId]: {
          clientMessageId, sessionId, text, attachments, snippets,
          status: sent ? "sending" : "failed", ...(sent ? {} : { error: "Mac 에 닿지 않아 보내지 못했습니다." }),
        },
      },
    }));
    if (sent) {
      this.sendTimers.set(clientMessageId, setTimeout(() => {
        setState((current) => {
          const outgoing = current.outbox[clientMessageId];
          if (outgoing === undefined || outgoing.status !== "sending") return current;
          return { ...current, outbox: { ...current.outbox, [clientMessageId]: { ...outgoing, status: "failed", error: "답이 오지 않았습니다." } } };
        });
      }, SEND_TIMEOUT_MS));
    }
    return clientMessageId;
  }

  discardOutgoing(clientMessageId: string): void {
    setState((current) => {
      const outbox = { ...current.outbox };
      delete outbox[clientMessageId];
      return { ...current, outbox };
    });
  }

  respond(sessionId: string, requestId: string, answer: ClientAnswer): boolean {
    const sent = this.send({ type: "respond", sessionId, requestId, answer });
    if (!sent) {
      toast("Mac 에 닿지 않아 답을 보내지 못했습니다. 다시 연결되면 한 번 더 누르십시오.", { tone: "error" });
      return false;
    }
    setState((current) => ({ ...current, answers: { ...current.answers, [requestId]: "sending" } }));
    setTimeout(() => {
      // 결과가 오지 않았고 카드가 아직 있다 — 다시 누를 수 있게 푼다
      const still = Object.values(getState().data).some((data) => data.view?.pending.some((pending) => pending.requestID === requestId) === true);
      if (still && getState().answers[requestId] === "sending") setState((current) => ({ ...current, answers: withoutSending(current.answers, requestId) }));
    }, RESPOND_TIMEOUT_MS);
    return sent;
  }
}

function withoutSending(answers: AppState["answers"], only?: string): AppState["answers"] {
  return Object.fromEntries(Object.entries(answers).filter(([requestId, state]) => state !== "sending" || (only !== undefined && requestId !== only)));
}

export const connection = new Connection();
