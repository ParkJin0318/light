/**
 * Claude Code 가 스스로 유지하는 라이브 세션 레지스트리 — `~/.claude/sessions/<pid>.json`.
 * 세션이 정상 종료하면 CLI 가 파일을 지우므로
 * 「지금 이 맥에서 도는 세션」의 원천이다. 파일이 있다고 살아 있는 것은 아니다 — pid 재사용은 프로세스 시작 시각으로 거른다
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { processStart as realProcessStart } from "./process-info.ts";

export interface ClaudeSessionRecord {
  pid: number;
  sessionID: string;
  cwd: string;
  /** 진행 중 턴이 있는가 — 가져오기에서 SIGINT 를 먼저 보낼지가 여기서 갈린다 */
  status?: "busy" | "idle";
  /** "cli" 는 터미널, "sdk-ts"·"sdk-cli" 는 프로그램(데스크톱 앱·SDK)이 띄웠다 */
  entrypoint?: string;
  startedAt?: number;
  /** 프로세스 시작 시각 — UTC 고정 포맷("Tue Aug 25 06:21:43 2026") */
  procStart?: string;
}

const INT32_MAX = 2 ** 31 - 1;

/** 필수는 pid·sessionId 둘뿐이다 — 키 하나가 없다고 행을 버리면 그 세션이 통째로 사라진다 */
const wireSchema = z.object({
  pid: z.number().int().min(1).max(INT32_MAX),
  sessionId: z.string(),
  cwd: z.string().nullish(),
  status: z.string().nullish(),
  entrypoint: z.string().nullish(),
  startedAt: z.number().nullish(),
  procStart: z.string().nullish(),
});

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PROC_START = /^(?:sun|mon|tue|wed|thu|fri|sat) ([a-z]{3}) (\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2}) (\d{4})$/i;

export const ClaudeSessionRegistry = {
  directory(claudeHome: string): string {
    return join(claudeHome, "sessions");
  },

  /** 레지스트리 파일만 — 같은 폴더의 `<pid>.<sha256>.key` 는 비밀이라 이름 단계에서 걸러 열지도 않는다 */
  isRecordFile(fileName: string): boolean {
    return /^\d+\.json$/.test(fileName);
  },

  parse(data: string): ClaudeSessionRecord | undefined {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return undefined;
    }
    const wire = wireSchema.safeParse(json);
    if (!wire.success) return undefined;
    const row = wire.data;
    return {
      pid: row.pid, sessionID: row.sessionId, cwd: row.cwd ?? "",
      ...(row.status === "busy" || row.status === "idle" ? { status: row.status } : {}),
      ...(row.entrypoint != null ? { entrypoint: row.entrypoint } : {}),
      ...(row.startedAt != null ? { startedAt: row.startedAt } : {}),
      ...(row.procStart != null ? { procStart: row.procStart } : {}),
    };
  },

  /** procStart → epoch 밀리초. `ps -o lstart=` 는 한국어 로케일에서 읽을 수 없는 모양으로 찍혀 쓰지 않는다 */
  parseProcStart(text: string): number | undefined {
    const collapsed = text.split(" ").filter((part) => part !== "").join(" ");
    const match = PROC_START.exec(collapsed);
    if (!match) return undefined;
    const month = MONTHS.indexOf(match[1]!.toLowerCase());
    const [day, hour, minute, second, year] = match.slice(2).map(Number) as [number, number, number, number, number];
    if (month < 0 || hour > 23 || minute > 59 || second > 59) return undefined;
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
    return date.getTime();
  },

  /**
   * pid 재사용 가드 — SIGKILL·크래시로 죽은 세션은 파일을 남기고, 그 pid 를 다른 프로세스가 물려받으면
   * 유령 세션이 뜨고 가져오기가 무관한 프로세스를 죽인다. `processStart` 가 undefined 면 프로세스가 없다
   */
  isLive(record: ClaudeSessionRecord, processStart: number | undefined): boolean {
    if (processStart === undefined) return false;
    const procStart = record.procStart === undefined ? undefined : ClaudeSessionRegistry.parseProcStart(record.procStart);
    if (procStart !== undefined) return Math.abs(procStart - processStart) <= 2000;
    if (record.startedAt !== undefined) {
      // CLI 가 기동을 마치고 찍는 값이라 프로세스 시작보다 1~2초 늦다(실측)
      const delta = record.startedAt - processStart;
      return delta >= -2000 && delta <= 30_000;
    }
    return true;
  },

  liveRecords(
    claudeHome: string,
    processStart: (pid: number) => number | undefined = realProcessStart,
    readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  ): ClaudeSessionRecord[] {
    const folder = ClaudeSessionRegistry.directory(claudeHome);
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    const records: ClaudeSessionRecord[] = [];
    for (const name of names) {
      if (!ClaudeSessionRegistry.isRecordFile(name)) continue;
      let data: string;
      try {
        data = readFile(join(folder, name));
      } catch {
        continue;
      }
      const record = ClaudeSessionRegistry.parse(data);
      if (record && ClaudeSessionRegistry.isLive(record, processStart(record.pid))) records.push(record);
    }
    return records;
  },
} as const;
