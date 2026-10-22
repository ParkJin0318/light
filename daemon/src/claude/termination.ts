/**
 * 터미널의 claude 를 끝낸다(가져오기).
 * busy 면 SIGINT 로 진행 중 턴을 먼저 기록시키고(SIGTERM 은 미완으로 남겨 재개한 턴이 통째로 빈다)
 * SIGTERM → 유예 → SIGKILL. 대상은 claude pid 하나다 — 부모 셸에 보내면 사람의 터미널 창이 닫힌다
 */

export interface TerminationSeams {
  send(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  isProcessAlive(pid: number): boolean;
  now(): number;
}

/** kill(pid, 0) — EPERM 은 「있으나 권한 없음」이라 살아 있다고 본다 */
export function isProcessAlive(pid: number): boolean {
  // process.kill 은 0·음수를 프로세스 그룹으로 읽는다
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const liveSeams: TerminationSeams = {
  send: (pid, signal) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, signal);
    } catch {
      // 이미 죽었다
    }
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  isProcessAlive,
  now: () => Date.now(),
};

/** SIGINT 와 SIGTERM 사이 — 진행 중 턴이 결과를 기록할 짬 */
const INTERRUPT_DELAY_MS = 600;
/** SIGTERM 뒤 SIGKILL 까지 — SessionEnd 훅과 MCP 서버 정리가 돌 시간 */
const GRACE_MS = 3_000;
const KILL_WAIT_MS = 1_000;
const POLL_MS = 120;

async function waitForExit(pid: number, timeout: number, seams: TerminationSeams): Promise<boolean> {
  const deadline = seams.now() + timeout;
  while (seams.now() < deadline) {
    if (!seams.isProcessAlive(pid)) return true;
    await seams.sleep(POLL_MS);
  }
  return !seams.isProcessAlive(pid);
}

/** 정말 죽었는가 — 가져오기는 true 일 때만 resume 한다 */
export async function signalUntilExit(pid: number, busy: boolean, seams: TerminationSeams = liveSeams): Promise<boolean> {
  if (!(pid > 0)) return false;
  if (busy) {
    seams.send(pid, "SIGINT");
    await seams.sleep(INTERRUPT_DELAY_MS);
  }
  seams.send(pid, "SIGTERM");
  if (await waitForExit(pid, GRACE_MS, seams)) return true;
  // 이미 죽은 pid 에 쏘면 그 번호를 물려받은 남을 죽인다 — 살아 있을 때만
  if (seams.isProcessAlive(pid)) seams.send(pid, "SIGKILL");
  return waitForExit(pid, KILL_WAIT_MS, seams);
}
