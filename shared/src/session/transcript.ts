/**
 * 기록 파일(`~/.claude/projects/<슬러그>/<sid>.jsonl`) 재생.
 * resume 은 과거 대화를 다시 흘려주지 않으므로(실측) 본문은 기록을 같은 리듀서로 재생해 그린다
 */
import type { RewindPoint } from "../protocol.ts";
import { splitAttachments } from "./attachments.ts";
import { autoContinuationDisplay } from "./auto-continuation.ts";
import { forkDirectiveDisplay } from "./commands.ts";
import { ConversationReducer, newConversationModel, type ConversationModel } from "./conversation.ts";
import { jarr, jbool, jget, jstr, parseJSON, type JSONValue } from "./json-value.ts";
import { decodeInbound, type WireInbound } from "./wire.ts";

/** 기록에만 남는 system 줄 가운데 화면에 구분선으로 보일 것 */
const REPLAYED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(["turn_duration", "local_command"]);

/** user·assistant 줄과 턴 도중에 들어온 입력만 SDK 메시지로 — 모르는 모양은 뺀다 */
export function decodeTranscriptLine(json: JSONValue): WireInbound | undefined {
  const type = jstr(jget(json, "type"));
  const line = type === "attachment" ? queuedCommandLine(json)
    : type === "user" || type === "assistant" || (type === "system" && REPLAYED_SYSTEM_SUBTYPES.has(jstr(jget(json, "subtype")) ?? "")) ? json
    : undefined;
  if (line === undefined) return undefined;
  const decoded = decodeInbound(line);
  return decoded.kind === "unknown" ? undefined : decoded;
}

/**
 * 턴이 도는 중에 들어온 입력은 user 줄이 아니라 `attachment`(`queued_command`)로 남는다(실측).
 * user 줄 모양으로 바꿔 같은 길로 보낸다
 */
function queuedCommandLine(json: JSONValue): JSONValue | undefined {
  const attachment = jget(json, "attachment");
  if (jstr(jget(attachment, "type")) !== "queued_command") return undefined;
  const mode = jstr(jget(attachment, "commandMode"));
  const prompt = jget(attachment, "prompt");
  if ((mode !== "prompt" && mode !== "task-notification") || prompt === undefined) return undefined;
  const origin = jget(attachment, "origin") ?? (mode === "task-notification" ? { kind: "task-notification" } : undefined);
  const timestamp = jget(attachment, "timestamp") ?? jget(json, "timestamp");
  return {
    type: "user", message: { role: "user", content: prompt },
    ...(origin !== undefined ? { origin } : {}), ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

const parentOf = (entry: JSONValue): string | undefined => jstr(jget(entry, "parentUuid")) ?? jstr(jget(entry, "logicalParentUuid"));

/**
 * 지금 이어지는 갈래의 줄만 원래 순서대로. 되감기는 줄을 지우지 않고 앞 메시지에 새 자식을 붙여 갈래를 낸다(실측).
 * 끝 잎에서 `parentUuid` 를 거슬러 오르고 압축 경계는 `logicalParentUuid` 로 건넌다.
 * `custom-title` 줄은 uuid 가 있어도 `parentUuid` 키가 없다(실측) — 끝 잎으로 잡으면 대화가 통째로 빈다
 */
export function activeBranch(entries: JSONValue[], leaf?: string): JSONValue[] {
  const unforked = entries.filter((entry) => jbool(jget(entry, "isSidechain")) !== true);
  if (!unforked.some((entry) => jstr(jget(entry, "uuid")) !== undefined)) return unforked;
  const conversational = unforked.filter((entry) => {
    if (jstr(jget(entry, "uuid")) === undefined) return false;
    if (jget(entry, "parentUuid") !== undefined || jget(entry, "logicalParentUuid") !== undefined) return true;
    const type = jstr(jget(entry, "type"));
    return type === "user" || type === "assistant";
  });
  const byID = new Map<string, JSONValue>();
  for (const entry of conversational) {
    const id = jstr(jget(entry, "uuid"));
    if (id !== undefined) byID.set(id, entry);
  }
  const start = (leaf !== undefined && byID.has(leaf) ? leaf : undefined) ?? jstr(jget(conversational.at(-1), "uuid"));
  if (start === undefined) return [];
  const chain = new Set<string>();
  let cursor: string | undefined = start;
  while (cursor !== undefined) {
    const entry = byID.get(cursor);
    if (entry === undefined || chain.has(cursor)) break;
    chain.add(cursor);
    cursor = parentOf(entry);
  }
  // 한 메시지가 도구를 여럿 부르면 결과가 저마다 자기 `tool_use` 줄에 매달려 곁가지가 된다(실측) — 그 결과 줄도 살린다
  return conversational.filter((entry) => {
    if (chain.has(jstr(jget(entry, "uuid")) ?? "")) return true;
    const parent = jstr(jget(entry, "parentUuid"));
    return parent !== undefined && chain.has(parent) && isToolResultLine(entry);
  });
}

function isToolResultLine(entry: JSONValue): boolean {
  if (jstr(jget(entry, "type")) !== "user") return false;
  return (jarr(jget(entry, "message", "content")) ?? []).some((block) => jstr(jget(block, "type")) === "tool_result");
}

/** 기록 줄 → 대화 모델. `pace` 는 줄마다 부른다 — 양보할 때만 Promise 를 준다 */
export async function replayTranscript(entries: JSONValue[], leaf?: string, pace?: () => Promise<void> | undefined): Promise<ConversationModel> {
  const model = newConversationModel();
  for (const json of activeBranch(entries, leaf)) {
    const decoded = decodeTranscriptLine(json);
    if (decoded !== undefined) ConversationReducer.apply({ kind: "inbound", inbound: decoded }, model);
    await pace?.();
  }
  return ConversationReducer.finishReplay(model);
}

/** 기록의 제목 셋과 작업 폴더 — 마지막 `custom-title`·마지막 `ai-title`·첫 사람 프롬프트 */
export interface TranscriptTitles {
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
}

/** 줄 하나씩 먹인다 — 파일 앞뒤 조각만 읽는 쪽이 쓴다 */
export function transcriptTitles(lines: Iterable<string>): TranscriptTitles {
  const found: TranscriptTitles = {};
  for (const line of lines) {
    const interesting = line.includes("\"ai-title\"") || line.includes("\"custom-title\"")
      || (found.firstPrompt === undefined && line.includes("\"type\":\"user\"")) || (found.cwd === undefined && line.includes("\"cwd\""));
    if (!interesting) continue;
    const json = parseJSON(line);
    if (json === undefined) continue;
    const type = jstr(jget(json, "type"));
    if (found.cwd === undefined) {
      const cwd = jstr(jget(json, "cwd"));
      if (cwd !== undefined && cwd !== "") found.cwd = cwd;
    }
    const custom = jstr(jget(json, "customTitle"));
    const ai = jstr(jget(json, "aiTitle"));
    if (type === "custom-title" && custom !== undefined && custom !== "") found.customTitle = custom;
    else if (type === "ai-title" && ai !== undefined && ai !== "") found.aiTitle = ai;
    else if (found.firstPrompt === undefined && type === "user" && jbool(jget(json, "isMeta")) !== true && jbool(jget(json, "isSidechain")) !== true) {
      const text = promptText(jget(json, "message", "content"));
      if (text !== undefined) found.firstPrompt = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
  return found;
}

function promptText(content: JSONValue | undefined): string | undefined {
  const raw = typeof content === "string" ? content
    : (jarr(content) ?? []).flatMap((block) => (jstr(jget(block, "type")) === "text" ? [jstr(jget(block, "text")) ?? ""] : [])).join("\n");
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith(ConversationReducer.interruptMarker)) return undefined;
  const command = ConversationReducer.tagContent("command-name", trimmed);
  if (command !== undefined) {
    const args = ConversationReducer.tagContent("command-args", trimmed) ?? "";
    return args === "" ? command : `${command} ${args}`;
  }
  if (trimmed.startsWith("<")) return undefined;
  return trimmed.split("\n")[0]!.trim();
}

/**
 * 되감을 수 있는 자리 — 지금 갈래의 사람 메시지. 도구 결과·메타·명령 출력·압축 요약·중단 표시·
 * 데몬이 보낸 이어 가기 턴은 자리가 아니다. 앞이 잘린 기록(긴 세션의 끝부분만 읽었다)의 첫 메시지는 앞 assistant 를 모르므로 뺀다 —
 * 첫 메시지로 오인하면 대화가 통째로 사라진다. 최근 것부터
 */
export function rewindPointsFromEntries(entries: JSONValue[]): RewindPoint[] {
  const branch = activeBranch(entries);
  const first = branch[0];
  const truncated = first === undefined ? false : parentOf(first) !== undefined;
  const points: RewindPoint[] = [];
  let lastAssistant: string | undefined;
  for (const entry of branch) {
    const id = jstr(jget(entry, "uuid"));
    if (id === undefined) continue;
    const type = jstr(jget(entry, "type"));
    if (type === "assistant") {
      lastAssistant = id;
      continue;
    }
    if (type !== "user" || jbool(jget(entry, "isMeta")) === true || jbool(jget(entry, "isCompactSummary")) === true) continue;
    const origin = jstr(jget(entry, "origin", "kind"));
    if (origin !== undefined && origin !== "human") continue;
    const text = humanText(jget(entry, "message", "content"));
    if (text === undefined || autoContinuationDisplay(text) !== undefined) continue;
    if (lastAssistant === undefined && truncated) continue;
    const stamp = jstr(jget(entry, "timestamp"));
    const timestamp = stamp === undefined ? Number.NaN : Date.parse(stamp);
    // 입력창에 돌려 둘 글 — 첨부 머리는 떼고 fork 지시는 사람이 친 모양으로
    const split = splitAttachments(text);
    const shown = forkDirectiveDisplay(split.text) ?? split.text;
    points.push({
      id, text: shown === "" ? `(첨부 ${split.files.length + split.snippets.length}개)` : shown,
      ...(Number.isFinite(timestamp) ? { timestamp } : {}), ...(lastAssistant !== undefined ? { resumeAt: lastAssistant } : {}),
    });
  }
  return points.reverse();
}

/** 모델 턴을 만들지 않는 내장 명령 — 되감을 자리가 아니다 */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "compact", "clear", "model", "effort", "context", "usage", "cost", "mcp", "output-style", "fast",
  "permissions", "resume", "rewind", "rename", "exit", "config", "memory", "status", "help", "plan",
  "login", "logout", "agents", "hooks", "doctor", "theme", "vim", "add-dir",
]);

function humanText(content: JSONValue | undefined): string | undefined {
  let text: string | undefined;
  const blocks = jarr(content);
  if (typeof content === "string") {
    text = content;
  } else if (blocks !== undefined) {
    // 도구 결과가 섞인 줄은 사람 말이 아니다
    if (blocks.some((block) => jstr(jget(block, "type")) === "tool_result")) return undefined;
    text = blocks.flatMap((block) => (jstr(jget(block, "type")) === "text" ? [jstr(jget(block, "text")) ?? ""] : [])).join("\n");
  }
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed.startsWith(ConversationReducer.interruptMarker)) return undefined;
  // 명령으로 보낸 턴은 태그 줄로만 남는다 — 사람이 친 명령으로 되살린다
  const name = ConversationReducer.tagContent("command-name", trimmed);
  if (name !== undefined) {
    const command = name.startsWith("/") ? name.slice(1) : name;
    const args = ConversationReducer.tagContent("command-args", trimmed) ?? "";
    if (LOCAL_COMMANDS.has(command) && !(command === "plan" && args !== "")) return undefined;
    return args === "" ? `/${command}` : `/${command} ${args}`;
  }
  // `!` 셸 줄·그 밖의 태그 덩어리는 사람 말이 아니다. 인용으로 시작하는 글(`<!-- attach -->`)은 사람 말이다
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && !trimmed.startsWith("<!-- attach")) return undefined;
  return trimmed;
}
