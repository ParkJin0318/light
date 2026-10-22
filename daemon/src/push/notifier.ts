/**
 * 누구에게 알릴지 — 기기 단위로 판정한다.
 * - 그 세션을 지금 보고 있는 기기에는 보내지 않는다. 「보고 있다」는 45초 임차라 기기가 끊기면 저절로 풀린다
 * - 턴 완료 본문은 CLI 가 뒤에서 짓는 턴 요약을 5초까지 기다려 쓴다. 오지 않으면 마지막 답의 첫 줄이다.
 *   기다리는 사이 다음 턴이 시작하면 알리지 않는다
 * - 410·404 로 실패한 구독은 지우고 Mac 앱에 표시한다
 * - 보낸 것과 PWA 의 수신 확인을 `push.jsonl` 에 남긴다 — 도착 비율을 여기서 잰다
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { VIEWING_LEASE_MS } from "../../../shared/src/protocol.ts";
import type { LightSettings } from "../../../shared/src/settings.ts";
import { log } from "../log.ts";
import type { DeviceStore } from "../stores.ts";
import { sendPush, type Fetcher, type VapidKeys } from "./web-push.ts";

export type NotificationKind = "permission" | "question" | "turnDone" | "error" | "test";

const KIND_LABELS: Record<NotificationKind, string> = {
  permission: "승인 요청", question: "질문", turnDone: "응답 완료", error: "오류", test: "테스트 알림",
};

export interface NotificationRequest {
  kind: NotificationKind;
  sessionId: string;
  project: string;
  /** 본문 — 잠금 화면 감추기를 켜면 쓰지 않는다 */
  body: string;
  requestId?: string;
}

export interface PushPayload {
  id: string;
  /** 받은 기기 — 서비스 워커가 수신을 알릴 때 싣는다 */
  device: string;
  kind: NotificationKind;
  sessionId: string;
  requestId?: string;
  title: string;
  body: string;
  /** 알림을 누르면 열 곳 — 그 세션의 그 카드 */
  url: string;
  tag: string;
}

export interface TurnDoneRequest {
  sessionId: string;
  project: string;
  summary: () => string | undefined;
  fallback: () => string;
  /** 다시 일하기 시작했으면 알리지 않는다 */
  stillIdle: () => boolean;
}

export class Notifier {
  private readonly viewing = new Map<string, { sessionId: string; until: number; owner?: string }>();
  private readonly waiting = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly deps: {
    devices: DeviceStore;
    settings: () => LightSettings;
    vapid: VapidKeys;
    pushLog: string;
    fetcher?: Fetcher;
    now?: () => number;
    summaryWaitMs?: number;
  }) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** `owner` 는 알린 연결 — 다시 붙은 기기의 옛 연결이 늦게 닫혀도 새 연결의 임차를 지우지 않는다 */
  setViewing(deviceId: string, sessionId: string | null, owner?: string): void {
    if (sessionId === null) this.viewing.delete(deviceId);
    else this.viewing.set(deviceId, { sessionId, until: this.now() + VIEWING_LEASE_MS, ...(owner !== undefined ? { owner } : {}) });
  }

  /** 연결이 끝났다 — 그 연결이 건 임차만 거둔다 */
  releaseViewing(deviceId: string, owner: string): void {
    if (this.viewing.get(deviceId)?.owner === owner) this.viewing.delete(deviceId);
  }

  isViewing(deviceId: string, sessionId: string): boolean {
    const lease = this.viewing.get(deviceId);
    return lease !== undefined && lease.sessionId === sessionId && lease.until > this.now();
  }

  private enabled(kind: NotificationKind): boolean {
    return kind === "test" || this.deps.settings().notifications[kind];
  }

  async notify(request: NotificationRequest, onlyDevice?: string): Promise<{ sent: number; failed: number }> {
    if (!this.enabled(request.kind)) return { sent: 0, failed: 0 };
    const hide = this.deps.settings().hideLockScreenBody;
    let sent = 0;
    let failed = 0;
    const deliveries = this.deps.devices.all().map(async (device) => {
      if (device.subscription === undefined) return;
      if (onlyDevice !== undefined && device.id !== onlyDevice) return;
      if (request.kind !== "test" && this.isViewing(device.id, request.sessionId)) return;
      const payload: PushPayload = {
        id: randomUUID(), device: device.id, kind: request.kind, sessionId: request.sessionId,
        ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
        title: hide ? request.project : `${KIND_LABELS[request.kind]} · ${request.project}`,
        body: hide ? KIND_LABELS[request.kind] : request.body,
        url: request.sessionId === "" ? "/" : `/#/s/${encodeURIComponent(request.sessionId)}${request.requestId !== undefined ? `?card=${encodeURIComponent(request.requestId)}` : ""}`,
        tag: `${request.sessionId}:${request.kind}`,
      };
      const subject = device.origin?.startsWith("https://") === true ? device.origin : "mailto:light@users.noreply.github.com";
      const result = await sendPush(device.subscription, payload, this.deps.vapid, subject, {
        urgency: request.kind === "turnDone" ? "normal" : "high",
        ...(this.deps.fetcher !== undefined ? { fetcher: this.deps.fetcher } : {}),
      });
      this.record({ at: new Date().toISOString(), push: payload.id, device: device.id, kind: request.kind, session: request.sessionId, ok: result.ok, status: result.status });
      if (result.ok) {
        sent += 1;
        this.deps.devices.patch(device.id, { lastPushOkAt: Date.now(), lastPushError: undefined });
        return;
      }
      failed += 1;
      if (result.gone) {
        log("warn", "push subscription gone", { device: device.id, status: result.status });
        this.deps.devices.patch(device.id, { subscription: undefined, expiredAt: Date.now(), lastPushError: result.error });
      } else {
        this.deps.devices.patch(device.id, { lastPushError: result.error });
      }
    });
    await Promise.all(deliveries);
    return { sent, failed };
  }

  /** 턴 완료 — 요약을 기다렸다가 보낸다. 같은 세션의 앞 대기는 거둔다 */
  turnDone(request: TurnDoneRequest, pollMs = 250): void {
    this.cancel(request.sessionId);
    if (!this.enabled("turnDone")) return;
    const startedAt = this.now();
    const waitMs = this.deps.summaryWaitMs ?? 5_000;
    const check = (): boolean => {
      if (!request.stillIdle()) return true;
      const summary = request.summary();
      if (summary === undefined && this.now() - startedAt < waitMs) return false;
      void this.notify({ kind: "turnDone", sessionId: request.sessionId, project: request.project, body: summary ?? request.fallback() });
      return true;
    };
    if (check()) return;
    const timer = setInterval(() => {
      if (!check()) return;
      clearInterval(timer);
      this.waiting.delete(request.sessionId);
    }, pollMs);
    this.waiting.set(request.sessionId, timer);
  }

  cancel(sessionId: string): void {
    const timer = this.waiting.get(sessionId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.waiting.delete(sessionId);
  }

  /** PWA 서비스 워커가 받았다고 알렸다 */
  ack(pushId: string, deviceId: string): void {
    this.record({ at: new Date().toISOString(), ack: pushId, device: deviceId });
  }

  private record(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.deps.pushLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // 기록을 못 남겨도 알림은 간다
    }
  }

  shutdown(): void {
    for (const timer of this.waiting.values()) clearInterval(timer);
    this.waiting.clear();
  }
}
