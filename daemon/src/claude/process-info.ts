/**
 * 프로세스 시작 시각 — `proc_pidinfo(PROC_PIDTBSDINFO)` 를 `bun:ffi` 로 부른다.
 *
 * `ps -o lstart=`로 읽지 않는 이유는 로케일이다: 한국어 환경에서
 * "2026년 8월 25일 화요일 15시 21분 43초"로 찍혀 파싱할 포맷이 없다.
 * proc_pidinfo는 epoch 초를 그대로 준다
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const PROC_PIDTBSDINFO = 3;
/** sizeof(struct proc_bsdinfo) — 반환값이 이 크기가 아니면 프로세스가 없다(또는 읽을 권한이 없다) */
const PROC_BSDINFO_SIZE = 136;
const OFFSET_PID = 12; // pbi_pid (uint32)
const OFFSET_START_SEC = 120; // pbi_start_tvsec (uint64)

type ProcPidInfo = (pid: number, flavor: number, arg: bigint, buffer: ReturnType<typeof ptr>, size: number) => number;

let cached: ProcPidInfo | null | undefined;

/** 첫 호출 때만 연다 — import 만으로 dylib 을 열지 않는다. macOS 가 아니면 null */
function procPidInfo(): ProcPidInfo | null {
  if (cached !== undefined) return cached;
  try {
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    cached = library.symbols.proc_pidinfo as unknown as ProcPidInfo;
  } catch {
    cached = null;
  }
  return cached;
}

function bsdInfo(pid: number): DataView | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined;
  const call = procPidInfo();
  if (!call) return undefined;
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE);
  const read = call(pid, PROC_PIDTBSDINFO, 0n, ptr(buffer), PROC_BSDINFO_SIZE);
  if (read !== PROC_BSDINFO_SIZE) return undefined;
  const view = new DataView(buffer.buffer);
  // 남의 구조체를 읽고 있지 않은지 — 오프셋이 어긋난 OS 에서 조용히 틀린 값을 내지 않는다
  return view.getUint32(OFFSET_PID, true) === pid ? view : undefined;
}

/** 프로세스 시작 시각(epoch 밀리초, 초 단위로 떨어진다) — 프로세스가 없으면 undefined */
export function processStart(pid: number): number | undefined {
  const view = bsdInfo(pid);
  return view ? Number(view.getBigUint64(OFFSET_START_SEC, true)) * 1000 : undefined;
}
