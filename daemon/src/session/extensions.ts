/**
 * 세션 확장 — 세션 옵션에 얹는 몫(프로세스 안 도구·훅·시스템 프롬프트·env)을 한 규칙으로 합친다.
 *
 * 합치는 규칙
 * - `mcpServers`: 이름이 겹치면 던진다. 조용히 덮으면 먼저 얹은 쪽의 도구가 사라진다
 * - `hooks`: 이벤트마다 뒤에 잇는다. PreToolUse 훅이 둘이고 하나가 allow·하나가 deny 면 deny 가 이긴다(실측, SDK 0.3.290)
 * - `autoAllow`: 사람이 고른 권한 모드와 무관하게 묻지 않고 쓰는 도구 — PreToolUse 훅의 allow 로 한다. 이름만 적은 `allowedTools` 는
 *   기동마다 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 경고를 찍는다(실측, 0.3.299). 화면만 바꾸는 light 의 도구만 넣는다
 * - `environment`: 세션 env 에 얹는다. 이름이 겹치면 던진다
 * - `systemPrompt`: 시스템 프롬프트 끝에 얹은 순서대로 잇는다 — 확장이 얹은 도구의 사용 규칙
 */
import type { HookCallbackMatcher, HookEvent, HookJSONOutput, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";

export interface SessionContribution {
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** 묻지 않고 쓰는 도구의 전체 이름(`mcp__<서버>__<도구>`) — 화면만 바꾸는 것 */
  autoAllow?: string[];
  /** 시스템 프롬프트 끝에 붙일 글 — 이 확장의 도구를 언제 어떻게 쓰는지 */
  systemPrompt?: string;
  /** 세션 env 에 얹을 값 */
  environment?: Record<string, string>;
}

/** 옵션에 확장의 몫을 합친다 — 받은 옵션은 건드리지 않는다 */
export function extendOptions<T extends Pick<Options, "mcpServers" | "hooks" | "systemPrompt">>(options: T, contributions: readonly SessionContribution[]): T {
  if (contributions.length === 0) return options;
  const mcpServers: Record<string, McpServerConfig> = { ...options.mcpServers };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const [event, matchers] of Object.entries(options.hooks ?? {})) hooks[event as HookEvent] = [...(matchers ?? [])];
  const appended: string[] = [];
  const autoAllow = new Set<string>();
  for (const contribution of contributions) {
    for (const [name, server] of Object.entries(contribution.mcpServers ?? {})) {
      if (Object.hasOwn(mcpServers, name)) throw new Error(`이미 실린 MCP 서버 이름입니다: ${name}`);
      mcpServers[name] = server;
    }
    for (const [event, matchers] of Object.entries(contribution.hooks ?? {})) {
      if (matchers === undefined || matchers.length === 0) continue;
      hooks[event as HookEvent] = [...(hooks[event as HookEvent] ?? []), ...matchers];
    }
    for (const name of contribution.autoAllow ?? []) autoAllow.add(name);
    const prompt = contribution.systemPrompt?.trim();
    if (prompt !== undefined && prompt !== "") appended.push(prompt);
  }
  if (autoAllow.size > 0) hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { hooks: [autoAllowHook(autoAllow)] }];
  const systemPrompt = appended.reduce<Options["systemPrompt"]>((current, text) => appendToSystemPrompt(current, text), options.systemPrompt);
  return {
    ...options,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}

/** 확장들이 얹은 env — 이름이 겹치면 던진다 */
export function contributedEnvironment(contributions: readonly SessionContribution[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const contribution of contributions) {
    for (const [name, value] of Object.entries(contribution.environment ?? {})) {
      if (Object.hasOwn(environment, name)) throw new Error(`이미 얹은 세션 env 입니다: ${name}`);
      environment[name] = value;
    }
  }
  return environment;
}

/** PreToolUse 훅의 판정 출력 */
export function preToolUseOutput(decision: "allow", reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

/** 그 이름의 도구만 허용한다 — 나머지는 답하지 않아 다른 훅과 권한 모드에 맡긴다 */
function autoAllowHook(names: ReadonlySet<string>): HookCallbackMatcher["hooks"][number] {
  return async (input): Promise<HookJSONOutput> => {
    const toolName = (input as { tool_name?: unknown }).tool_name;
    return typeof toolName === "string" && names.has(toolName) ? preToolUseOutput("allow", "light 의 도구입니다.") : {};
  };
}

/**
 * 시스템 프롬프트 끝에 글을 붙인다 — 프리셋이면 `append` 뒤에, 글이면 빈 줄 뒤에, 배열이면 마지막 조각으로.
 * 프롬프트가 없으면(SDK 의 최소 프롬프트) 붙이지 않는다 — light 의 세션은 늘 프리셋으로 뜬다
 */
export function appendToSystemPrompt(systemPrompt: Options["systemPrompt"], text: string): Options["systemPrompt"] {
  if (systemPrompt === undefined) return undefined;
  if (typeof systemPrompt === "string") return `${systemPrompt}\n\n${text}`;
  if (Array.isArray(systemPrompt)) return [...systemPrompt, text];
  if (systemPrompt.type === "preset") return { ...systemPrompt, append: systemPrompt.append === undefined ? text : `${systemPrompt.append}\n\n${text}` };
  return systemPrompt;
}
