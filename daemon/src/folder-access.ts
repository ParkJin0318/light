/**
 * 세션 폴더를 동기로 읽기 전에 지나는 문.
 * macOS 개인정보 보호(TCC)는 문서·데스크톱·네트워크 볼륨 같은 폴더를 처음 읽는 앱의 open() 을 허용 창에 답이 날 때까지 붙잡는다.
 * 다른 앱의 같은 종류 창이 답을 기다리는 동안에는 창도 없이 그 뒤에 줄 선다. 데몬 주 스레드에서 동기로 읽다 붙잡히면 HTTP 까지 데몬 전체가 멈춘다
 * (2026-10-31 맥미니 실측 — 화면 앞에 사람이 없어 영영 풀리지 않았다). 그래서 스레드 풀에서 폴더를 먼저 읽어 보고 시한 안에 답이 없으면 까닭을 알리며 실패한다.
 * 답이 난 폴더는 이 프로세스에서 다시 붙잡히지 않으니 그 뒤의 동기 읽기는 막히지 않는다
 */
import { readdir } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 5_000;
const HELD = Symbol("held");

export interface FolderAccessOptions {
  /** 폴더 하나를 읽는다 — 시험은 대역을 넣는다 */
  probe?: (folder: string) => Promise<unknown>;
  timeoutMs?: number;
}

export class FolderAccess {
  /** 아직 답이 안 난 읽기 — 같은 폴더로 풀 스레드를 또 붙잡지 않는다 */
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly probe: (folder: string) => Promise<unknown>;
  private readonly timeoutMs: number;

  constructor(options: FolderAccessOptions = {}) {
    this.probe = options.probe ?? ((folder) => readdir(folder));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 읽을 수 있으면 돌아온다. 붙잡혔거나 막혔으면 할 일을 담아 던진다. 그 밖의 실패(없는 폴더 등)는 뒤의 단계가 알린다 */
  async ensure(folder: string): Promise<void> {
    if (this.pending.has(folder)) throw new Error(heldMessage(folder, this.timeoutMs));
    // 실패도 값으로 바꿔 둔다 — 시한이 먼저 끝나면 이 약속은 아무도 기다리지 않는다
    const reading = this.probe(folder)
      .then(() => undefined, (error: unknown) => error ?? new Error("읽기 실패"))
      .finally(() => this.pending.delete(folder));
    this.pending.set(folder, reading);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<typeof HELD>((resolve) => {
      timer = setTimeout(() => resolve(HELD), this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([reading, held]);
      if (outcome === HELD) throw new Error(heldMessage(folder, this.timeoutMs));
      const code = (outcome as { code?: unknown } | undefined)?.code;
      if (code === "EPERM" || code === "EACCES") throw new Error(deniedMessage(folder));
    } finally {
      clearTimeout(timer);
    }
  }
}

function heldMessage(folder: string, timeoutMs: number): string {
  return `Mac 이 「${folder}」 폴더 읽기를 ${Math.round(timeoutMs / 1000)}초 넘게 붙잡고 있습니다. macOS 개인정보 보호 허용 창이 Mac 화면에서 답을 기다릴 때 이렇습니다. `
    + "Mac 에서 그 창에 답하거나 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근에서 light 를 켠 뒤 다시 보내십시오.";
}

function deniedMessage(folder: string): string {
  return `macOS 가 light 의 「${folder}」 폴더 읽기를 막았습니다. 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근(또는 파일 및 폴더)에서 light 를 켜십시오.`;
}
