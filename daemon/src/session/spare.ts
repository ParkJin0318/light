/**
 * 예열한 예비 세션 — 새 세션이 프로세스 기동·도구·MCP 연결을
 * 기다리지 않게 하나를 미리 띄워 둔다(SDK `prewarm`). 데스크톱 앱과 같은 길이다.
 *
 * - 예열 때 정해지는 것: 실행 파일·env·시스템 프롬프트·콜백·세션 id. 이 값들의 지문(`signature`)이 바뀌면 예비를 버린다
 * - claim 때 정하는 것: 폴더·권한 모드·모델·추가 폴더·설정 덮어쓰기(`ClaimOptions`)
 * - claim 이 거절되면 프롬프트는 돌지 않았다(d.ts) — 세션이 입력을 되감아 보통의 `query()` 로 띄운다
 * 실측(CLI 2.1.300): 예열 0.97초, claim 뒤 첫 메시지 40ms
 */
import {
  prewarm as sdkPrewarm, type CanUseTool, type ClaimOptions, type OnElicitation, type OnUserDialog, type Options, type SpareProcess,
  type SpawnedProcess, type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { asSpawned, spawnClaude } from "../claude/spawn.ts";
import { log, errorText } from "../log.ts";

/** 예비를 claim 한 세션이 이어받는 콜백 */
export interface SpareCallbacks {
  canUseTool: CanUseTool;
  onElicitation: OnElicitation;
  onUserDialog: OnUserDialog;
  spawned: (process: SpawnedProcess) => void;
  stderr: (data: string) => void;
}

export interface TakenSpare {
  id: string;
  /** 콜백을 claim 한 세션에 잇는다 — claim 전에 부른다 */
  bind(callbacks: SpareCallbacks): void;
  process: Pick<SpareProcess, "claim" | "claimed" | "close" | "exited">;
}

export interface SpareTemplate {
  /** 예열 옵션 — 폴더·권한 모드·모델은 없다 */
  options: Options;
  /** 이 옵션을 만든 입력의 지문 — 같은 지문일 때만 꺼낸다 */
  signature: string;
}

export type Prewarm = (params: { options: Options }) => Promise<Pick<SpareProcess, "claim" | "claimed" | "close" | "exited">>;

interface Parked {
  id: string;
  signature: string;
  process?: Pick<SpareProcess, "claim" | "claimed" | "close" | "exited">;
  ready: boolean;
  callbacks: { target?: SpareCallbacks };
  child?: SpawnedProcess;
}

export class SpareSessions {
  private parked: Parked | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private closed = false;
  private readonly prewarm: Prewarm;

  constructor(private readonly init: {
    /** 예열할 본 — 없으면(예열을 껐다·claude 가 없다) 예열하지 않는다 */
    template: () => Promise<SpareTemplate | undefined>;
    prewarm?: Prewarm;
    delayMs?: number;
  }) {
    this.prewarm = init.prewarm ?? ((params) => sdkPrewarm(params));
  }

  /** 곧 하나를 예열한다 — 이미 있으면 그대로. 연달아 세 번 실패하면 멈춘다 */
  schedule(): void {
    if (this.closed || this.parked !== undefined || this.timer !== undefined || this.failures >= 3) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.warm();
    }, this.init.delayMs ?? 2_000);
  }

  /** 지금 예열한 것과 같은 본이면 꺼낸다. 꺼냈으면 다음 예비를 예열한다 */
  take(signature: string): TakenSpare | undefined {
    const parked = this.parked;
    if (parked === undefined || !parked.ready || parked.process === undefined) return undefined;
    if (parked.signature !== signature) {
      // 설정이 바뀌어 본이 낡았다 — 버리고 새로 예열한다
      this.discard();
      this.schedule();
      return undefined;
    }
    this.parked = undefined;
    this.schedule();
    return {
      id: parked.id,
      bind: (callbacks) => {
        parked.callbacks.target = callbacks;
        if (parked.child !== undefined) callbacks.spawned(parked.child);
      },
      process: parked.process,
    };
  }

  /** 예열한 프로세스의 pid — 레지스트리에서 이 데몬의 프로세스로 거른다 */
  get pid(): number | undefined {
    return (this.parked?.child as { pid?: number } | undefined)?.pid;
  }

  discard(): void {
    const parked = this.parked;
    this.parked = undefined;
    try {
      parked?.process?.close();
    } catch {
      // 이미 내려갔다
    }
  }

  shutdown(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.discard();
  }

  private async warm(): Promise<void> {
    if (this.closed || this.parked !== undefined) return;
    let template: SpareTemplate | undefined;
    try {
      template = await this.init.template();
    } catch {
      template = undefined;
    }
    if (template === undefined || this.closed || this.parked !== undefined) return;
    const parked: Parked = { id: randomUUID(), signature: template.signature, ready: false, callbacks: {} };
    this.parked = parked;
    const deny = { behavior: "deny" as const, message: "The session is not attached yet." };
    const options: Options = {
      ...template.options,
      sessionId: parked.id,
      // 예열 때 콜백을 건다 — claim 한 세션이 자기 것으로 잇는다(`bind`)
      canUseTool: (name, input, extra) => parked.callbacks.target?.canUseTool(name, input, extra) ?? Promise.resolve(deny),
      onElicitation: (request, extra) => parked.callbacks.target?.onElicitation(request, extra) ?? Promise.resolve({ action: "cancel" as const }),
      onUserDialog: (dialog, extra) => parked.callbacks.target?.onUserDialog(dialog, extra) ?? Promise.resolve({ behavior: "cancelled" as const }),
      stderr: (data) => parked.callbacks.target?.stderr(data),
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
        // stderr 는 claim 한 세션으로 — 그 전에는 버린다(비워 줘야 claude 가 멈추지 않는다)
        const child = spawnClaude(spawnOptions, (data) => parked.callbacks.target?.stderr(data));
        parked.child = asSpawned(child);
        return parked.child;
      },
    };
    const startedAt = Date.now();
    try {
      const process = await this.prewarm({ options });
      if (this.parked !== parked) {
        process.close();
        return;
      }
      parked.process = process;
      parked.ready = true;
      this.failures = 0;
      log("info", "spare ready", { ms: Date.now() - startedAt });
      void process.exited.then(() => {
        // 쓰기 전에 죽었으면 새로 예열한다
        if (this.parked !== parked) return;
        this.parked = undefined;
        this.failures += 1;
        this.schedule();
      });
    } catch (error) {
      if (this.parked === parked) this.parked = undefined;
      this.failures += 1;
      log("warn", "prewarm failed", { error: errorText(error) });
      this.schedule();
    }
  }
}

/** claim 때 넘길 것 — 폴더·권한 모드·모델·추가 폴더·설정 덮어쓰기 */
export function claimOptions(options: Options): ClaimOptions {
  return {
    cwd: options.cwd ?? process.cwd(),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.additionalDirectories !== undefined ? { additionalDirectories: options.additionalDirectories } : {}),
    ...(options.settings !== undefined && typeof options.settings !== "string" ? { settings: options.settings as ClaimOptions["settings"] } : {}),
  };
}
