/**
 * 세션 하나의 동기화 통로 — 리듀서 항목을 앞 스냅샷과 참조로 견줘 바뀐 것만 순번 붙은 패치로 보낸다.
 * 리듀서는 바뀐 항목을 새 객체로 갈아 끼우므로 참조 비교가 곧 변경 감지다. 항목을 지우거나 비우면(`structure`)
 * epoch 를 갈고 스냅샷을 다시 보낸다. 최근 패치는 고리 버퍼에 쥐어 재접속한 기기가 빠진 것만 받게 한다
 */
import { randomUUID } from "node:crypto";
import type { ServerMessage, SessionView, ViewItem } from "../../../shared/src/protocol.ts";
import type { ConversationItem, ConversationModel } from "../../../shared/src/session/conversation.ts";
import { toViewItem } from "../../../shared/src/session/view.ts";

export interface Subscriber {
  send(message: ServerMessage): void;
}

interface PatchRecord {
  seq: number;
  upserts: { index: number; item: ViewItem }[];
  total: number;
}

/** 패치를 모으는 간격 — 스트리밍 중 글자마다 보내지 않는다 */
const FLUSH_MS = 40;
/** 쥐는 패치 수 — 이보다 오래 끊겼던 기기는 스냅샷을 받는다 */
const RING_SIZE = 600;
/** 스냅샷에 싣는 끝 부분 항목 수 */
const SNAPSHOT_ITEMS = 150;

export class SessionChannel {
  epoch = randomUUID().slice(0, 8);
  seq = 0;
  private shown: ConversationItem[] = [];
  private shownStructure = -1;
  private shownView = "";
  private ring: PatchRecord[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly source: () => { model: ConversationModel; view: SessionView; cwd: string },
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  markDirty(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  /** 모델을 통째로 갈았다(기록에서 다시 읽었다) — 모두에게 스냅샷 */
  reset(): void {
    this.newEpoch();
    this.shownStructure = -1;
    this.flush();
  }

  /** 앞 순번을 이어 줄 수 없다 — 기기는 epoch 가 다르면 스냅샷을 받는다 */
  private newEpoch(): void {
    this.epoch = randomUUID().slice(0, 8);
    this.seq = 0;
    this.ring = [];
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const { model, view, cwd } = this.source();
    if (model.structure !== this.shownStructure) {
      if (this.shownStructure !== -1) this.newEpoch();
      this.shownStructure = model.structure;
      this.shown = [...model.items];
      this.shownView = JSON.stringify(view);
      for (const subscriber of this.subscribers) subscriber.send(this.snapshot());
      return;
    }
    const upserts: PatchRecord["upserts"] = [];
    const items = model.items;
    for (let index = 0; index < items.length; index += 1) {
      if (items[index] !== this.shown[index]) upserts.push({ index, item: toViewItem(items[index]!, cwd) });
    }
    this.shown = [...items];
    const viewJSON = JSON.stringify(view);
    const viewChanged = viewJSON !== this.shownView;
    this.shownView = viewJSON;
    if (upserts.length === 0 && !viewChanged) return;
    this.seq += 1;
    const record: PatchRecord = { seq: this.seq, upserts, total: items.length };
    this.ring.push(record);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    const message: ServerMessage = {
      type: "patch", sessionId: this.sessionId, epoch: this.epoch, seq: record.seq, upserts, total: record.total,
      ...(viewChanged ? { view } : {}),
    };
    for (const subscriber of this.subscribers) subscriber.send(message);
  }

  /** 마지막 순번 다음부터 — 이어 줄 수 없으면 스냅샷 */
  subscribe(subscriber: Subscriber, epoch?: string, lastSeq?: number): void {
    this.flush();
    this.subscribers.add(subscriber);
    const oldest = this.ring[0]?.seq ?? this.seq + 1;
    if (epoch === this.epoch && lastSeq !== undefined && lastSeq <= this.seq && lastSeq >= oldest - 1) {
      const missing = this.ring.filter((record) => record.seq > lastSeq);
      const { view } = this.source();
      if (missing.length === 0) {
        subscriber.send({ type: "patch", sessionId: this.sessionId, epoch: this.epoch, seq: this.seq, upserts: [], total: this.shown.length, view });
        return;
      }
      missing.forEach((record, index) => {
        subscriber.send({
          type: "patch", sessionId: this.sessionId, epoch: this.epoch, seq: record.seq, upserts: record.upserts, total: record.total,
          ...(index === missing.length - 1 ? { view } : {}),
        });
      });
      return;
    }
    subscriber.send(this.snapshot());
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  snapshot(): ServerMessage {
    const { model, view, cwd } = this.source();
    const total = model.items.length;
    const firstIndex = Math.max(0, total - SNAPSHOT_ITEMS);
    return {
      type: "snapshot", sessionId: this.sessionId, epoch: this.epoch, seq: this.seq, firstIndex, total,
      items: model.items.slice(firstIndex).map((item) => toViewItem(item, cwd)), view,
    };
  }

  /** 앞부분 나눠 받기 — `before` 앞의 `limit` 개 */
  page(before: number, limit: number): { firstIndex: number; items: ViewItem[]; epoch: string; seq: number } {
    // 바뀐 것을 먼저 흘려 페이지가 정확히 이 순번의 모양이 되게 한다 — 기기는 이보다 뒤의 패치를 덧씌운다
    this.flush();
    const { model, cwd } = this.source();
    const end = Math.max(0, Math.min(before, model.items.length));
    const start = Math.max(0, end - limit);
    return { firstIndex: start, items: model.items.slice(start, end).map((item) => toViewItem(item, cwd)), epoch: this.epoch, seq: this.seq };
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.subscribers.clear();
  }
}
