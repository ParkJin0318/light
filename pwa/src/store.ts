/**
 * 화면 상태 한 벌 — 데몬이 보낸 목록·세션 항목을 쥔다. 데몬이 정본이고 화면은 받은 대로 그린다.
 * 패치는 순번이 이어질 때만 받고, 끊겼으면 연결이 다시 구독해 빠진 것을 채운다
 */
import { useSyncExternalStore } from "react";
import type { ModelOption, ServerMessage, SessionSummary, SessionView, ViewItem } from "../../shared/src/protocol.ts";
import type { AttachedSnippet } from "../../shared/src/session/attachments.ts";
import { APIError } from "./api.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "unreachable";

export interface SessionData {
  epoch?: string;
  seq: number;
  /** 쥐고 있는 첫 항목의 전체 위치 */
  firstIndex: number;
  total: number;
  items: ViewItem[];
  view?: SessionView;
  loadingEarlier: boolean;
  /** 쥐지 않은 앞부분 항목에 온 패치 — 앞부분을 받으면 그 페이지보다 새 것만 덧씌운다 */
  early: Record<number, { seq: number; item: ViewItem }>;
}

/** 보내는 중이거나 보내지 못한 메시지 */
export interface Outgoing {
  clientMessageId: string;
  sessionId: string;
  text: string;
  attachments: string[];
  snippets: AttachedSnippet[];
  status: "sending" | "failed";
  error?: string;
}

export interface AppConfig {
  version: string;
  hostId: string;
  vapidPublicKey: string;
  defaultPermissionMode: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  limits: { imagesPerMessage: number; imageLongSide: number; imageBytes: number; fileBytes: number; filesPerMessage: number; documentBytes: number; documentPages: number };
}

export interface AppState {
  connection: ConnectionState;
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  data: Record<string, SessionData>;
  outbox: Record<string, Outgoing>;
  /** 카드 답의 결과 — 다른 기기가 먼저 답했으면 handled */
  answers: Record<string, "sending" | "handled" | "error">;
  config?: AppConfig;
  /** claude 가 알려 준 모델 목록 — 못 받았으면 없다(내장 목록을 쓴다) */
  models?: ModelOption[];
  toast?: Toast;
  /** 열 때 한 재구독이 실패한 까닭 */
  pushError?: string;
  /** 세션마다 다음 메시지에 붙일 인용 — 답의 글을 골라 「인용해 묻기」로 쌓는다 */
  quotes: Record<string, AttachedSnippet[]>;
  /** 입력창에 넣을 글 — 되감은 메시지를 돌려 둔다. 입력창이 한 번 꺼내 가면 지운다 */
  drafts: Record<string, string>;
}

let state: AppState = { connection: "connecting", sessions: [], sessionsLoaded: false, data: {}, outbox: {}, answers: {}, quotes: {}, drafts: {} };
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(change: (current: AppState) => AppState): void {
  const next = change(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function useAppState<T>(select: (state: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}

/**
 * 화면 아래의 짧은 알림. 오류나 되돌리기 동작이 붙은 알림은 저절로 사라지지 않고 닫을 때까지 남는다 —
 * 폰에서는 3초 만에 사라지면 놓친다
 */
export interface Toast {
  text: string;
  at: number;
  tone?: "error";
  action?: { label: string; run: () => void };
}

export function toast(text: string, options: { tone?: "error"; action?: Toast["action"] } = {}): void {
  setState((current) => ({ ...current, toast: { text, at: Date.now(), ...options } }));
}

/**
 * 실패의 글 — 데몬이 준 까닭(APIError)이 있으면 그것, 없으면 다음에 할 일을 적은 대신 글.
 * Mac 에 닿지 않을 때 브라우저가 던지는 TypeError(「Load failed」)는 할 일이 없는 영어라 보이지 않는다
 */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof APIError && error.message !== "" ? error.message : fallback;
}

export function toastError(error: unknown, fallback: string): void {
  toast(errorText(error, fallback), { tone: "error" });
}

/** 인용 한 조각을 다음 메시지에 붙인다 — 한 메시지에 10개까지 */
export function addQuote(sessionId: string, snippet: AttachedSnippet): void {
  setState((current) => {
    const list = current.quotes[sessionId] ?? [];
    if (list.length >= 10) return current;
    return { ...current, quotes: { ...current.quotes, [sessionId]: [...list, snippet] } };
  });
}

export function removeQuote(sessionId: string, index: number): void {
  setState((current) => ({ ...current, quotes: { ...current.quotes, [sessionId]: (current.quotes[sessionId] ?? []).filter((_, at) => at !== index) } }));
}

export function clearQuotes(sessionId: string): void {
  setState((current) => {
    if ((current.quotes[sessionId] ?? []).length === 0) return current;
    const quotes = { ...current.quotes };
    delete quotes[sessionId];
    return { ...current, quotes };
  });
}

export function setDraft(sessionId: string, text: string): void {
  setState((current) => ({ ...current, drafts: { ...current.drafts, [sessionId]: text } }));
}

/** 입력창이 꺼내 간다 — 없으면 undefined */
export function takeDraft(sessionId: string): string | undefined {
  const draft = state.drafts[sessionId];
  if (draft === undefined) return undefined;
  const drafts = { ...state.drafts };
  delete drafts[sessionId];
  setState((current) => ({ ...current, drafts }));
  return draft;
}

export function dismissToast(at: number): void {
  setState((current) => (current.toast?.at === at ? { ...current, toast: undefined } : current));
}

function withSession(current: AppState, sessionId: string, data: SessionData): AppState {
  return { ...current, data: { ...current.data, [sessionId]: data } };
}

/** 패치를 반영한다 — 이어지지 않으면 `gap` 으로 알려 다시 구독하게 한다 */
export function applySessionMessage(message: Extract<ServerMessage, { type: "snapshot" | "patch" }>): { gap: boolean } {
  let gap = false;
  setState((current) => {
    const previous = current.data[message.sessionId];
    if (message.type === "snapshot") {
      return withSession(current, message.sessionId, {
        epoch: message.epoch, seq: message.seq, firstIndex: message.firstIndex, total: message.total, items: message.items,
        view: message.view, loadingEarlier: false, early: {},
      });
    }
    if (previous === undefined || previous.epoch !== message.epoch || message.seq > previous.seq + 1) {
      gap = true;
      return current;
    }
    // 이미 받은 패치 — 다시 구독하며 겹쳐 온 것
    if (message.seq <= previous.seq && message.upserts.length > 0) return current;
    const items = [...previous.items];
    let early = previous.early;
    for (const { index, item } of message.upserts) {
      const at = index - previous.firstIndex;
      if (at < 0) {
        early = { ...early, [index]: { seq: message.seq, item } };
        continue;
      }
      if (at < items.length) items[at] = item;
      else if (at === items.length) items.push(item);
      else gap = true;
    }
    if (gap) return current;
    return withSession(current, message.sessionId, {
      ...previous, seq: Math.max(previous.seq, message.seq), total: message.total, items, early, ...(message.view !== undefined ? { view: message.view } : {}),
    });
  });
  return { gap };
}

/** 앞부분을 붙인다 — 페이지를 만든 순번(`pageSeq`) 뒤에 그 자리에 온 패치는 덧씌운다 */
export function prependItems(sessionId: string, epoch: string, firstIndex: number, items: ViewItem[], pageSeq: number): void {
  setState((current) => {
    const previous = current.data[sessionId];
    if (previous === undefined || previous.epoch !== epoch) return current;
    const overlap = previous.firstIndex - firstIndex;
    if (overlap <= 0) return withSession(current, sessionId, { ...previous, loadingEarlier: false });
    const early = { ...previous.early };
    const added = items.slice(0, overlap).map((item, offset) => {
      const index = firstIndex + offset;
      const newer = early[index];
      delete early[index];
      return newer !== undefined && newer.seq > pageSeq ? newer.item : item;
    });
    return withSession(current, sessionId, { ...previous, firstIndex, items: [...added, ...previous.items], loadingEarlier: false, early });
  });
}

export function setLoadingEarlier(sessionId: string, loading: boolean): void {
  setState((current) => {
    const previous = current.data[sessionId];
    return previous === undefined ? current : withSession(current, sessionId, { ...previous, loadingEarlier: loading });
  });
}
