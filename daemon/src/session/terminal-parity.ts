/**
 * 터미널과 맞추기 — `.mcp.json` 판정·Bash 한도·Chrome·사고 표시.
 * 터미널은 프로젝트 `.mcp.json` 에서 처음 보는 MCP 서버를 띄우기 전에 묻는다. SDK 세션은 묻지 않고 승인한다(2.1.300 바이너리, 실측).
 * light 는 아직 정하지 않은 서버를 세션 플래그 층의 `disabledMcpjsonServers` 로 끄고 띄운 뒤 대화에 알린다 —
 * 승인은 터미널의 승인 창(이 폴더의 `.claude/settings.local.json`)에서 한다. 정한 기록은 세 설정 파일에서 읽는다
 */
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readObject(path: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** claude 가 읽는 설정 파일 셋 — 사용자 → 프로젝트 → 로컬 순으로 덮는다 */
function settingsFiles(home: string, cwd: string): string[] {
  return [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
}

/**
 * 사고 표시(`--thinking-display`) — SDK 세션은 플래그가 없으면 표시를 정하지 않아 사고 본문이 빈다(실측).
 * 데스크톱 앱처럼 `summarized` 로 띄우되, 설정 층 어디든 `showThinkingSummaries: false` 가 마지막이면 `omitted`
 */
export function thinkingDisplay(home: string, cwd: string): "summarized" | "omitted" {
  let shows: boolean | undefined;
  for (const path of settingsFiles(home, cwd)) {
    const value = readObject(path)?.showThinkingSummaries;
    if (typeof value === "boolean") shows = value;
  }
  return shows === false ? "omitted" : "summarized";
}

/**
 * Claude in Chrome — 터미널은 `~/.claude.json` 의 `claudeInChromeDefaultEnabled` 를 따르고 비대화형은 이 값을 보지 않고 끈다.
 * env `CLAUDE_CODE_ENABLE_CFC` 가 그 판정보다 앞이라 같은 값을 env 로 건넨다(2.1.300 바이너리)
 */
export function chromeEnvironment(home: string): Record<string, string> {
  return readObject(join(home, ".claude.json"))?.claudeInChromeDefaultEnabled === true ? { CLAUDE_CODE_ENABLE_CFC: "1" } : {};
}

/** 이 폴더의 `.mcp.json` 에 적힌 서버 이름 */
function projectMcpServers(cwd: string): string[] {
  return Object.keys(asObject(readObject(join(cwd, ".mcp.json"))?.mcpServers) ?? {});
}

/** 어느 설정 파일에도 켜거나 끈 기록이 없고 「모두 사용」도 아닌 서버 — 터미널이 띄우기 전에 묻는 그 서버들 */
export function pendingProjectMcpServers(cwd: string, home: string): string[] {
  const servers = projectMcpServers(cwd);
  if (servers.length === 0) return [];
  const decided = new Set<string>();
  for (const path of settingsFiles(home, cwd)) {
    const settings = readObject(path);
    if (settings === undefined) continue;
    if (settings.enableAllProjectMcpServers === true) return [];
    for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) {
      const list = settings[key];
      if (Array.isArray(list)) for (const name of list) if (typeof name === "string") decided.add(name);
    }
  }
  return servers.filter((name) => !decided.has(name));
}

/*
 * Bash 시간 한도 — 터미널은 백그라운드 명령에 시한을 걸지 않는다(적힌 `timeout` 도 무시한다). SDK 세션만 시한이 있다:
 * 한도를 안 적었거나 포그라운드에서 넘어간 명령은 `BASH_DEFAULT_TIMEOUT_MS` 와 30분 가운데 큰 값, 적었으면 그 값,
 * 상한은 `BASH_MAX_TIMEOUT_MS` 와 2시간 가운데 큰 값이다(2.1.300 바이너리, 실측).
 * 두 env 를 2^31−1ms 로 올리면 백그라운드 시한이 풀린다. 같은 env 가 포그라운드의 기본값·상한도 올리므로
 * 훅이 포그라운드 호출을 터미널의 값으로 되돌리고 백그라운드 호출의 적힌 한도는 지운다
 */

/** 시한을 푼 값 — CLI 의 타이머가 받는 가장 큰 값 */
const UNBOUNDED_BASH_TIMEOUT_MS = 2_147_483_647;

export const BASH_TIMEOUT_ENVIRONMENT: Readonly<Record<string, string>> = {
  BASH_DEFAULT_TIMEOUT_MS: String(UNBOUNDED_BASH_TIMEOUT_MS),
  BASH_MAX_TIMEOUT_MS: String(UNBOUNDED_BASH_TIMEOUT_MS),
};

export interface TerminalBashTimeouts {
  defaultMs: number;
  maxMs: number;
}

/**
 * 터미널의 포그라운드 한도 — 기본값은 `BASH_DEFAULT_TIMEOUT_MS`(없으면 2분), 상한은 `BASH_MAX_TIMEOUT_MS`(없으면 10분)와 기본값 가운데 큰 값.
 * 값은 셸 env 뒤에 설정 파일의 `env` 가 덮는다(사용자 → 프로젝트 → 로컬)
 */
export function terminalBashTimeouts(environment: Readonly<Record<string, string | undefined>>, home: string, cwd: string): TerminalBashTimeouts {
  const merged: Record<string, string | undefined> = { ...environment };
  for (const path of settingsFiles(home, cwd)) {
    for (const [key, value] of Object.entries(asObject(readObject(path)?.env) ?? {})) if (typeof value === "string") merged[key] = value;
  }
  const positive = (value: string | undefined): number | undefined => {
    const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const defaultMs = positive(merged.BASH_DEFAULT_TIMEOUT_MS) ?? 120_000;
  return { defaultMs, maxMs: Math.max(positive(merged.BASH_MAX_TIMEOUT_MS) ?? 600_000, defaultMs) };
}

/** Bash 입력을 터미널 한도에 맞춘 것 — 고칠 것이 없으면 undefined */
export function bashTimeoutParity(toolName: string, input: unknown, terminal: TerminalBashTimeouts): Record<string, unknown> | undefined {
  const fields = asObject(input);
  if (toolName !== "Bash" || fields === undefined) return undefined;
  const timeout = typeof fields.timeout === "number" && fields.timeout > 0 ? fields.timeout : undefined;
  if (fields.run_in_background === true) {
    if (!Object.hasOwn(fields, "timeout")) return undefined;
    const { timeout: _dropped, ...rest } = fields;
    return rest;
  }
  if (timeout === undefined) return { ...fields, timeout: terminal.defaultMs };
  return timeout > terminal.maxMs ? { ...fields, timeout: terminal.maxMs } : undefined;
}

/** 모델에게 실제 한도를 알리는 한 줄 — 도구 설명의 숫자는 이 세션의 env 를 따라 바뀌어 있다 */
export function bashTimeoutNote(terminal: TerminalBashTimeouts): string {
  return `Bash timeouts in this session follow the interactive terminal, not the figures in the Bash tool description: a foreground command times out after ${terminal.defaultMs} ms unless you pass \`timeout\` (max ${terminal.maxMs} ms), and a command that runs in the background (\`run_in_background\`, or moved there after its timeout) is never stopped for running too long.`;
}

/** 세션에 얹는 훅 — Bash 입력은 결정 없이 고친 입력만 낸다(다른 훅·규칙의 allow·ask 는 그대로 선다). 서브에이전트에는 같은 안내를 맥락으로 */
export function bashTimeoutHooks(terminal: TerminalBashTimeouts): Partial<Record<"PreToolUse" | "SubagentStart", HookCallbackMatcher[]>> {
  const note = bashTimeoutNote(terminal);
  return {
    PreToolUse: [{
      matcher: "Bash",
      hooks: [async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const updatedInput = bashTimeoutParity(input.tool_name, input.tool_input, terminal);
        return updatedInput === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
      }],
    }],
    SubagentStart: [{
      hooks: [async (input) => (input.hook_event_name === "SubagentStart"
        ? { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: note } }
        : {})],
    }],
  };
}
