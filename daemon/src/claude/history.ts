/**
 * Claude Code 기록 — `~/.claude/projects/<cwd 슬러그>/<sid>.jsonl`.
 * 목록은 파일의 앞뒤 256KB 에서 제목·작업 폴더를 읽고 (경로, 수정 시각, 크기)로 쥔다 — 몇 초마다 다시 훑는다.
 * 본문은 끝 64MB 를 조각으로 읽어 같은 리듀서로 재생한다. 그동안 다른 세션의 화면이 멈추지 않게 틈틈이 양보한다
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationModel } from "../../../shared/src/session/conversation.ts";
import { parseJSON, type JSONValue } from "../../../shared/src/session/json-value.ts";
import type { RewindPoint } from "../../../shared/src/protocol.ts";
import { replayTranscript, rewindPointsFromEntries, transcriptTitles, type TranscriptTitles } from "../../../shared/src/session/transcript.ts";

export interface HistoryEntry {
  sessionID: string;
  path: string;
  cwd: string;
  title: string;
  modifiedAt: number;
  size: number;
}

const WINDOW = 256 * 1024;
const TAIL_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SLICE_MS = 12;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeHistory {
  private readonly titles = new Map<string, { modifiedAt: number; size: number; found: TranscriptTitles }>();

  constructor(private readonly claudeHome: string) {}

  get projectsRoot(): string {
    return join(this.claudeHome, "projects");
  }

  /** 최근 것부터 `limit` 개 — 대화가 없는 파일은 뺀다 */
  entries(limit = 150): HistoryEntry[] {
    let projects: string[];
    try {
      projects = readdirSync(this.projectsRoot);
    } catch {
      return [];
    }
    const candidates: { path: string; sessionID: string; modifiedAt: number; size: number; project: string }[] = [];
    for (const project of projects) {
      const directory = join(this.projectsRoot, project);
      let files: string[];
      try {
        files = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const sessionID = name.slice(0, -".jsonl".length);
        if (!SESSION_ID.test(sessionID)) continue;
        const path = join(directory, name);
        try {
          const stat = statSync(path);
          candidates.push({ path, sessionID, modifiedAt: stat.mtimeMs, size: stat.size, project });
        } catch {
          continue;
        }
      }
    }
    candidates.sort((lhs, rhs) => rhs.modifiedAt - lhs.modifiedAt);
    const result: HistoryEntry[] = [];
    for (const candidate of candidates) {
      if (result.length >= limit) break;
      const found = this.titlesOf(candidate.path, candidate.modifiedAt, candidate.size);
      const title = found.customTitle ?? found.aiTitle ?? found.firstPrompt;
      if (title === undefined) continue;
      result.push({
        sessionID: candidate.sessionID, path: candidate.path, cwd: found.cwd ?? `/${candidate.project}`,
        title, modifiedAt: candidate.modifiedAt, size: candidate.size,
      });
    }
    return result;
  }

  /** 슬러그 규칙을 흉내 내지 않고 session id 파일명으로 찾는다 */
  transcriptPath(sessionID: string): string | undefined {
    if (!SESSION_ID.test(sessionID)) return undefined;
    let projects: string[];
    try {
      projects = readdirSync(this.projectsRoot);
    } catch {
      return undefined;
    }
    for (const project of projects) {
      const candidate = join(this.projectsRoot, project, `${sessionID}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  titlesOfSession(sessionID: string): TranscriptTitles | undefined {
    const path = this.transcriptPath(sessionID);
    if (path === undefined) return undefined;
    try {
      const stat = statSync(path);
      return this.titlesOf(path, stat.mtimeMs, stat.size);
    } catch {
      return undefined;
    }
  }

  private titlesOf(path: string, modifiedAt: number, size: number): TranscriptTitles {
    const cached = this.titles.get(path);
    if (cached !== undefined && cached.modifiedAt === modifiedAt && cached.size === size) return cached.found;
    const found = readHeadTail(path);
    this.titles.set(path, { modifiedAt, size, found });
    return found;
  }

  /** 본문 재생 — 파일이 없으면 undefined. `leaf` 가 있으면 그 메시지까지의 갈래만 */
  async load(sessionID: string, leaf?: string): Promise<ConversationModel | undefined> {
    const path = this.transcriptPath(sessionID);
    const pace = pacer(SLICE_MS);
    const entries = path === undefined ? undefined : await readTailEntries(path, pace);
    return entries === undefined ? undefined : replayTranscript(entries, leaf, pace);
  }

  /** 되감을 수 있는 자리 — 지금 갈래의 사람 메시지, 최근 것부터. 기록이 없으면 빈 목록 */
  async rewindPoints(sessionID: string): Promise<RewindPoint[]> {
    const path = this.transcriptPath(sessionID);
    const entries = path === undefined ? undefined : await readTailEntries(path, pacer(SLICE_MS));
    return entries === undefined ? [] : rewindPointsFromEntries(entries);
  }
}

export function projectName(cwd: string): string {
  const name = basename(cwd);
  return name === "" ? cwd : name;
}

function readHeadTail(path: string): TranscriptTitles {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return {};
  }
  try {
    const size = fstatSync(descriptor).size;
    const head = Buffer.alloc(Math.min(WINDOW, size));
    const headRead = readSync(descriptor, head, 0, head.length, 0);
    let tail = Buffer.alloc(0);
    if (size > WINDOW) {
      tail = Buffer.alloc(WINDOW);
      const tailRead = readSync(descriptor, tail, 0, WINDOW, size - WINDOW);
      tail = tail.subarray(0, tailRead);
    }
    const text = `${head.subarray(0, headRead).toString("utf8")}\n${tail.toString("utf8")}`;
    return transcriptTitles(text.split("\n"));
  } catch {
    return {};
  } finally {
    closeSync(descriptor);
  }
}

/** 붙든 시간이 간격을 넘었을 때만 양보한다 — 줄마다 불러도 된다 */
function pacer(sliceMs: number): () => Promise<void> | undefined {
  let last = performance.now();
  return () => {
    if (performance.now() - last < sliceMs) return undefined;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        last = performance.now();
        resolve();
      }, 0);
    });
  };
}

/** 파일 끝 `TAIL_BYTES` 를 조각으로 읽으며 줄로 푼다. 크기는 연 순간의 것으로 굳힌다 — 세션이 쓰는 중인 파일이다 */
async function readTailEntries(path: string, pace: () => Promise<void> | undefined): Promise<JSONValue[] | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = (await handle.stat()).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const entries: JSONValue[] = [];
    let dropHead = start > 0;
    let carry = "";
    const take = (line: string): void => {
      if (line === "") return;
      const json = parseJSON(line);
      if (json !== undefined) entries.push(json);
    };
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, size - start)));
    let position = start;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const scanFrom = carry.length;
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let newline = carry.indexOf("\n", scanFrom);
      if (newline === -1) continue;
      let from = 0;
      if (dropHead) {
        from = newline + 1;
        dropHead = false;
        newline = carry.indexOf("\n", from);
      }
      while (newline !== -1) {
        take(carry.slice(from, newline));
        from = newline + 1;
        newline = carry.indexOf("\n", from);
      }
      carry = carry.slice(from);
      await pace();
    }
    carry += decoder.decode();
    take(carry);
    return entries;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
