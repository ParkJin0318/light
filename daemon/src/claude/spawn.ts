/**
 * claude 프로세스 띄우기 — SDK 의 `spawnClaudeCodeProcess` 로 넘긴다. 프로세스를 데몬이 쥐어야
 * 닫는 순서(입력 닫기 → 유예 → SIGTERM → SIGKILL)를 지킬 수 있다. stderr 는 늘 비워 준다(파이프가 차면 claude 가 멈춘다)
 */
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";

export function spawnClaude(options: SpawnOptions, onStderr: (data: string) => void): ChildProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
  // SDK 가 입력을 닫고 유예를 준 뒤에야 끊는 신호다 — 받으면 프로세스를 내린다
  options.signal?.addEventListener("abort", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }, { once: true });
  return child;
}

export function asSpawned(child: ChildProcess): SpawnedProcess {
  return child as unknown as SpawnedProcess;
}
