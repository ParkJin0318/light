/**
 * 사람 대신 데몬이 멈춘 턴을 이어 가는 두 경우 — 데스크톱 앱과 같은 문장·한도다.
 *
 * - 데몬 종료: 턴이 돌던 세션은 상태 파일에 그 턴의 시작 시각(`turnActiveAt`)이 남는다. 다음 기동에 하루 안의 것 가운데 최근 넷을
 *   다시 띄워 이어 가게 한다. 데몬이 죽어도(SIGKILL) 그 값이 남아 같은 길로 이어 간다. 고르지 않은 것은 표시를 지운다
 * - 잠자기: 데몬에는 전원 알림이 없어 5초 틱의 벽시계 간격이 30초를 넘으면 그사이 잠들었다고 본다. 깨어난 뒤 60초 동안 그 턴이
 *   아무것도 내지 않았고(리듀서 `revision` 이 그대로), 도는 도구·사람을 기다리는 요청·대기 입력이 없으면 턴을 멈추고 이어 가라는 턴을 보낸다
 *
 * 어느 쪽이든 턴의 출처는 `auto-continuation` 이다 — 사람 턴으로 찍지 않는다
 */
import { QUIT_CONTINUATION } from "../../../shared/src/session/auto-continuation.ts";

export const QUIT_RESUME = {
  ...QUIT_CONTINUATION,
  withinMs: 24 * 60 * 60 * 1000,
  limit: 4,
} as const;

/** 데몬이 꺼진 사이 멈춘 턴 가운데 이어 갈 것 — 하루 안의 것 가운데 최근 넷. 나머지는 지울 것 */
export function pickInterrupted<T extends { at: number }>(turns: readonly T[], now: number): { resume: T[]; dismiss: T[] } {
  const ordered = [...turns].sort((a, b) => b.at - a.at);
  const resume = ordered.filter((turn) => now - turn.at <= QUIT_RESUME.withinMs).slice(0, QUIT_RESUME.limit);
  return { resume, dismiss: ordered.filter((turn) => !resume.includes(turn)) };
}

/** 잠자기를 지켜볼 세션 하나 */
export interface SleepWatchTarget {
  id: string;
  /** 턴이 돌고 있으면 그 턴이 시작한 때(epoch 밀리초) — 쉬고 있으면 undefined */
  turnStartedAt(): number | undefined;
  /** CLI 가 무언가 낼 때마다 오르는 값(리듀서 `revision`) */
  revision(): number;
  /** 기다리는 것이 따로 있다 — 도는 도구 호출·사람을 기다리는 요청·대기 입력 */
  waiting(): boolean;
  /** 턴을 멈추고 이어 가라는 턴을 보낸다 */
  continueAfterSleep(): void;
}

export interface SleepWatchInit {
  sessions: () => readonly SleepWatchTarget[];
  now?: () => number;
  /** 틱 간격 — 기본 5초 */
  tickMs?: number;
  /** 이만큼 넘게 틱이 비면 잠들었다고 본다 — 기본 30초 */
  gapMs?: number;
  /** 깨어난 뒤 이만큼 조용해야 이어 간다 — 기본 60초 */
  graceMs?: number;
}

export class SleepWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick: number | undefined;
  /** 잠자기를 건넌 턴 — 깨어난 때와 그때의 revision */
  private readonly marks = new Map<string, { wokeAt: number; revision: number }>();
  private readonly lastContinued = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly init: SleepWatchInit) {
    this.now = init.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), this.init.tickMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 틱 하나 — 간격이 크면 잠들었다 깨어난 것이다. 그다음 조용히 기다린 턴을 이어 간다 */
  tick(at: number = this.now()): void {
    const previous = this.lastTick;
    this.lastTick = at;
    if (previous !== undefined && at - previous > (this.init.gapMs ?? 30_000)) this.woke(previous, at);
    this.settle(at);
  }

  private woke(lastTick: number, wokeAt: number): void {
    // 잠든 때는 마지막 틱과 그다음 틱 사이 어딘가다 — 그 사이에 시작한 턴도 잠자기를 건넜다
    const latestSleep = lastTick + (this.init.tickMs ?? 5_000);
    for (const session of this.init.sessions()) {
      const startedAt = session.turnStartedAt();
      if (startedAt === undefined || startedAt > latestSleep) continue;
      this.marks.set(session.id, { wokeAt, revision: session.revision() });
    }
  }

  private settle(at: number): void {
    if (this.marks.size === 0) return;
    const sessions = new Map(this.init.sessions().map((session) => [session.id, session]));
    for (const [id, mark] of [...this.marks]) {
      if (at - mark.wokeAt < (this.init.graceMs ?? 60_000)) continue;
      this.marks.delete(id);
      const session = sessions.get(id);
      // 끝났거나, 깨어난 뒤 무언가 냈거나(스스로 이어 갔다), 따로 기다리는 것이 있으면 두고 본다
      if (session === undefined || session.turnStartedAt() === undefined || session.revision() !== mark.revision || session.waiting()) continue;
      const last = this.lastContinued.get(id);
      if (last !== undefined && at - last < 60_000) continue;
      this.lastContinued.set(id, at);
      session.continueAfterSleep();
    }
  }
}
