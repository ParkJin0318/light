/**
 * 로그는 Mac 에만 남는다(텔레메트리 없음). `logs/daemon.log` 에 한 줄씩 쓰고 stderr 에도 낸다.
 * 프롬프트 본문·도구 입력은 남기지 않는다 — 세션 id 와 사건만
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

let directory: string | undefined;
let quiet = false;

export function configureLog(logsDirectory: string, options: { quiet?: boolean } = {}): void {
  directory = logsDirectory;
  quiet = options.quiet ?? false;
  mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
}

export function logPath(): string | undefined {
  return directory === undefined ? undefined : join(directory, "daemon.log");
}

export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  if (!quiet) process.stderr.write(`${line}\n`);
  const path = logPath();
  if (path === undefined) return;
  try {
    // 5MB 를 넘으면 한 벌만 돌려 둔다
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    // 로그를 못 써도 데몬은 돈다
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
