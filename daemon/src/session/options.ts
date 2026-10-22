/**
 * 세션 하나가 받는 Agent SDK 옵션.
 * `canUseTool`·`onElicitation`·`onUserDialog`·`spawnClaudeCodeProcess` 는 `LiveSession` 이 얹는다.
 * 훅·프로세스 안 도구·덧붙이는 프롬프트는 세션 확장(`extensions.ts`) 하나의 규칙으로 합친다
 */
import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "../../../shared/src/protocol.ts";
import type { TaskEntry } from "../../../shared/src/session/conversation.ts";
import type { LightSettings } from "../../../shared/src/settings.ts";
import { SUPPORTED_DIALOG_KINDS } from "../../../shared/src/session/pending.ts";
import { TURN_MCP_SERVER, TURN_SYSTEM_PROMPT, UPDATE_PLAN_FULL_NAME, WRAP_UP_FULL_NAME } from "../../../shared/src/session/turn-box.ts";
import { extendOptions, type SessionContribution } from "./extensions.ts";
import { BASH_TIMEOUT_ENVIRONMENT, bashTimeoutHooks, bashTimeoutNote, type TerminalBashTimeouts } from "./terminal-parity.ts";
import { turnMcpServer } from "./turn-tools.ts";

/**
 * SDK 경로가 기본으로 꺼 두는 것을 터미널의 claude 와 같게 켠다 — 사람이 지켜보는 세션이다.
 * - fork 모드(갈래 서브에이전트)는 대화형에서만 기본으로 켜진다(공식 env 문서)
 * - WebSearch 한도의 시간당 재충전은 대화형이 100, 비대화형이 0 이다(2.1.290+)
 * - 120초 넘게 도는 MCP 호출·서브에이전트를 백그라운드로 넘기는 것도 대화형에서만 한다(2.1.300 바이너리)
 * - CLI 대화상자는 SDK 호스트에서만 5분 뒤 스스로 취소된다 — 0 이 그 마감을 끈다
 * - Artifact 도구는 기동 경로가 SDK 면 빠진다. 이 env 가 있을 때만 다시 들어온다(2.1.299 실측)
 * - 플러그인 폴더 감시(핫 리로드)는 대화형에서만 켜진다(공식 env 문서, 2.1.287+)
 * - 코드 되감기(`rewind_files`)는 파일 체크포인트가 켜져 있어야 한다 — `enableFileCheckpointing` 과 한 쌍이다
 */
const SESSION_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_FORK_SUBAGENT: "1",
  CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR: "100",
  CLAUDE_AUTO_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: "0",
  CLAUDE_CODE_ARTIFACT: "1",
  CLAUDE_CODE_PLUGIN_DIR_WATCH: "1",
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
};

/**
 * 세션 env 에서 빼는 것 — 데몬을 띄운 쪽(다른 Claude Code 세션 등)의 표식이 claude 에 새면 자기를 중첩 세션으로 알거나
 * 그 세션의 id·노력도·메시지 소켓을 제 것으로 읽는다(Claude Code 세션 안에서 띄운 데몬의 env 실측).
 * 인증: 구독으로 쓰면 셸의 API 키를 넘기지 않는다. light 는 OAuth 토큰·키체인을 읽지도 넘기지도 않는다
 */
const STRIPPED_PREFIXES = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "LIGHT_",
];

export function sessionEnvironment(shell: Readonly<Record<string, string>>, authMode: "subscription" | "apiKey"): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(shell)) {
    if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (authMode === "subscription" && (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN")) continue;
    environment[key] = value;
  }
  return { ...environment, ...SESSION_ENVIRONMENT };
}

/**
 * 시스템 프롬프트는 터미널과 같은 Claude Code 프리셋에 덧붙인다. 프리셋을 빼면 보안·안전 지침까지 빠진다.
 * 덧붙이는 글은 사람이 폰에서 본다는 사실과 `!` 셸 줄이다 — 터미널의 대화형 claude 가 싣는 `!` 안내를 light 의 셸 줄로 바꿨다.
 *
 * `snapshot: false` — CLI 는 시스템 프롬프트를 대화의 첫 요청에 기록(`prompt_snapshot`)하고 resume 마다 그 기록을 쓴다.
 * 그러면 터미널에서 시작해 폰으로 이어받은 세션에는 이 글이 닿지 않고, 폰에서 시작해 터미널에서 이어 간 세션에는 이 글이 남는다
 * (2026-10-22 실측). 기록하지 않으면 띄울 때마다 지금 띄운 쪽의 프롬프트로 돈다
 */
const APPEND = [
  "The user is driving this Claude Code session remotely from a phone or tablet through light. They read your messages and tool calls in a chat view and answer permission prompts there, but they cannot see or type into a terminal on this Mac.",
  "If you need the user to run a shell command themselves, suggest they send `! <command>` from the chat — the `!` prefix runs the command on this Mac in this session's folder and puts its output in the conversation. Commands that wait for interactive input do not work there.",
].join(" ");

export interface SessionPlan {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** 새 세션 — 데몬이 정한 id(SDK 는 첫 턴 전에는 id 를 알려 주지 않는다) */
  sessionId?: string;
  /** 이어 열 세션 */
  resume?: string;
  /** 대화 되감기 — 이 메시지까지만 이어 연다(같은 session id, 뒤는 갈래로 남는다). `resume` 이 있을 때만 뜻이 있다 */
  resumeAt?: string;
  /** 작업 폴더 밖에서 읽을 수 있게 여는 폴더 — 세션의 첨부 폴더 */
  additionalDirectories?: string[];
  /** 터미널의 Bash 포그라운드 한도 — 있으면 백그라운드 시한을 풀고 훅으로 포그라운드를 맞춘다(terminal-parity) */
  bashTimeouts?: TerminalBashTimeouts;
  /** 사고 표시 — 설정의 `showThinkingSummaries` 를 따른다(terminal-parity). 없으면 summarized */
  thinkingDisplay?: "summarized" | "omitted";
  /** 고른 노력도 — 없으면 claude 설정과 모델 기본값 */
  effort?: EffortLevel;
  /** 빠른 모드를 켠다 — SDK 경로는 플래그 층에 이 값이 있어야 연다 */
  fastMode?: boolean;
  /** 아직 승인하지 않은 프로젝트 `.mcp.json` 서버 — 끄고 띄운다(terminal-parity) */
  disabledMcpServers?: string[];
  /** 턴 도구(할 일 띠·다음 단계 상자)를 싣는다 — `seed` 는 이어 연 대화의 할 일 목록 */
  turnTools?: { seed: readonly TaskEntry[] };
}

export type PlannedOptions = Pick<Options,
  | "cwd" | "model" | "permissionMode" | "allowDangerouslySkipPermissions" | "sessionId" | "resume" | "resumeSessionAt" | "systemPrompt" | "settingSources"
  | "includePartialMessages" | "includeHookEvents" | "perTaskStopAffordance" | "agentProgressSummaries" | "promptSuggestions" | "enableFileCheckpointing"
  | "forwardSubagentText" | "toolConfig" | "extraArgs" | "additionalDirectories" | "hooks" | "mcpServers" | "settings">;

/**
 * 세션 플래그 층 — 노력도·빠른 모드·막은 MCP 서버를 한 층에 싣는다. 기동(`settings`)·예비 claim(`ClaimOptions.settings`)·
 * 세션 중 변경(`applyFlagSettings`)이 같은 층이라 어느 길로 떠도 같은 값이 선다
 */
function flagSettings(plan: SessionPlan): Options["settings"] | undefined {
  const settings = {
    ...(plan.disabledMcpServers !== undefined && plan.disabledMcpServers.length > 0 ? { disabledMcpjsonServers: [...plan.disabledMcpServers] } : {}),
    ...(plan.effort !== undefined ? { effortLevel: plan.effort } : {}),
    ...(plan.fastMode === true ? { fastMode: true } : {}),
  };
  return Object.keys(settings).length > 0 ? settings as Options["settings"] : undefined;
}

/** 설정이 켜고 끄는 확장 — 턴 도구(`seed` 는 이어 연 대화의 할 일 목록). 세션 기동과 예열이 같이 쓴다 */
export function settingsPlan(settings: LightSettings, seed: readonly TaskEntry[] = []): Pick<SessionPlan, "turnTools"> {
  return settings.turnTools ? { turnTools: { seed } } : {};
}

/** 이 세션에 얹을 확장의 몫 — Bash 한도 맞추기, 턴 도구 */
export function sessionContributions(plan: SessionPlan): SessionContribution[] {
  return [
    ...(plan.bashTimeouts !== undefined ? [{ hooks: bashTimeoutHooks(plan.bashTimeouts), systemPrompt: bashTimeoutNote(plan.bashTimeouts) }] : []),
    ...(plan.turnTools !== undefined ? [{
      mcpServers: { [TURN_MCP_SERVER]: turnMcpServer(plan.turnTools.seed) },
      autoAllow: [UPDATE_PLAN_FULL_NAME, WRAP_UP_FULL_NAME], systemPrompt: TURN_SYSTEM_PROMPT,
    }] : []),
  ];
}

/**
 * - 사용자·프로젝트 설정을 그대로 읽어 터미널에서 쓰던 CLAUDE.md·스킬·권한 규칙이 똑같이 적용된다
 * - `perTaskStopAffordance` 는 작업 하나씩 멈추는 길(`stopTask`)이 있다는 선언이다. 없으면 interrupt 가 백그라운드 에이전트까지 죽인다
 * - thinking 본문은 SDK 세션에서 기본이 빈 문자열이다 — 요약을 보이려면 표시 설정을 넘긴다(CLI 의 숨은 `--thinking-display`)
 * - 질문 선택지의 미리보기를 마크다운으로 받는다 — 걸지 않으면 모델이 미리보기를 쓰지 않는다
 * - `forwardSubagentText` 는 서브에이전트의 글·생각도 `parent_tool_use_id` 를 달아 흘린다 — 끄면 도구 호출만 온다
 */
export function sessionOptions(plan: SessionPlan): PlannedOptions {
  const settings = flagSettings(plan);
  const base: PlannedOptions = {
    cwd: plan.cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: APPEND, snapshot: false },
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    includeHookEvents: true,
    perTaskStopAffordance: true,
    agentProgressSummaries: true,
    forwardSubagentText: true,
    promptSuggestions: true,
    enableFileCheckpointing: true,
    toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
    extraArgs: { "thinking-display": plan.thinkingDisplay ?? "summarized" },
    ...(settings !== undefined ? { settings } : {}),
    // 폰의 권한 모드 목록은 늘 bypassPermissions 를 낸다 — 띄울 때부터 열어 두어야 도중에 그 모드로 바꿀 수 있다
    allowDangerouslySkipPermissions: true,
    ...(plan.permissionMode !== undefined ? { permissionMode: plan.permissionMode } : {}),
    ...(plan.model !== undefined && plan.model !== "" ? { model: plan.model } : {}),
    ...(plan.sessionId !== undefined ? { sessionId: plan.sessionId } : {}),
    ...(plan.resume !== undefined ? { resume: plan.resume } : {}),
    ...(plan.resume !== undefined && plan.resumeAt !== undefined ? { resumeSessionAt: plan.resumeAt } : {}),
    ...(plan.additionalDirectories !== undefined && plan.additionalDirectories.length > 0 ? { additionalDirectories: [...plan.additionalDirectories] } : {}),
  };
  return extendOptions(base, sessionContributions(plan));
}

/** 띄울 때 넘기는 옵션 — 세션 옵션에 실행 파일·env(Bash 시한을 푼다)·받는 CLI 대화상자를 얹는다. 세션과 예비가 같이 쓴다 */
export function launchOptions(plan: SessionPlan, environment: Readonly<Record<string, string>>, executable: string): Options {
  return {
    ...sessionOptions(plan),
    env: { ...environment, ...BASH_TIMEOUT_ENVIRONMENT },
    pathToClaudeCodeExecutable: executable,
    supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS],
  };
}

/** 동시 세션 상한 — `max(6, 메모리 / 3GiB)` */
export function defaultSessionLimit(totalMemoryBytes: number): number {
  return Math.max(6, Math.floor(totalMemoryBytes / (3 * 1024 ** 3)));
}
