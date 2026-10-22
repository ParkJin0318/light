/**
 * 도구 호출 한 줄 요약 — Read 는 경로, Edit 는 경로와 바뀐 줄 수, Bash 는 명령.
 * 화면은 이 줄을 그대로 쓴다. 펼치면 입력·출력 원문을 고정폭으로 보인다(문법 강조·diff 뷰는 하지 않는다)
 */
import { jarr, jget, jint, jobj, jstr, type JSONValue } from "./json-value.ts";

export interface ToolSummary {
  /** 카드 머리 — 도구 이름(MCP 도구는 서버와 도구) */
  title: string;
  /** 한 줄 요약 */
  line: string;
}

/** `cwd` 를 주면 그 아래 경로는 상대 경로로 줄인다 */
export function toolSummary(name: string, input: JSONValue, meta?: JSONValue, cwd?: string): ToolSummary {
  const path = (key: string): string => shortPath(jstr(jget(input, key)) ?? "", cwd);
  switch (name) {
    case "Read":
      return { title: "Read", line: withRange(path("file_path"), input) };
    case "Edit":
    case "MultiEdit":
      return { title: name, line: joined(path("file_path"), changeCount(name, input, meta)) };
    case "Write": {
      const content = jstr(jget(input, "content"));
      return { title: "Write", line: joined(path("file_path"), content === undefined ? undefined : `${lineCount(content)}줄`) };
    }
    case "NotebookEdit":
      return { title: name, line: path("notebook_path") };
    case "Bash":
      return { title: "Bash", line: firstLine(jstr(jget(input, "command")) ?? "") };
    case "UserShell":
      return { title: "셸", line: firstLine(jstr(jget(input, "command")) ?? "") };
    case "Grep":
      return { title: "Grep", line: joined(jstr(jget(input, "pattern")) ?? "", jstr(jget(input, "path")) === undefined ? undefined : path("path")) };
    case "Glob":
      return { title: "Glob", line: jstr(jget(input, "pattern")) ?? "" };
    case "WebFetch":
      return { title: "WebFetch", line: jstr(jget(input, "url")) ?? "" };
    case "WebSearch":
      return { title: "WebSearch", line: jstr(jget(input, "query")) ?? "" };
    case "Task":
    case "Agent":
      return { title: jstr(jget(input, "subagent_type")) ?? "Agent", line: jstr(jget(input, "description")) ?? firstLine(jstr(jget(input, "prompt")) ?? "") };
    case "TodoWrite":
      return { title: "할 일", line: `${(jarr(jget(input, "todos")) ?? []).length}개` };
    case "TaskCreate":
      return { title: "할 일 추가", line: jstr(jget(input, "subject")) ?? "" };
    case "TaskUpdate":
      return { title: "할 일 갱신", line: joined(jstr(jget(input, "taskId")) ?? "", jstr(jget(input, "status"))) };
    case "AskUserQuestion":
      return { title: "질문", line: jstr(jget(jarr(jget(input, "questions"))?.[0], "question")) ?? "" };
    case "ExitPlanMode":
      return { title: "계획", line: firstLine(jstr(jget(input, "plan")) ?? "") };
    case "Skill":
      return { title: "Skill", line: jstr(jget(input, "skill")) ?? jstr(jget(input, "command")) ?? "" };
    default: {
      if (name.startsWith("mcp__")) {
        const [, server = "", ...tool] = name.split("__");
        return { title: `${server} · ${tool.join("__")}`, line: firstStringValue(input) };
      }
      return { title: name, line: firstStringValue(input) };
    }
  }
}

function shortPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && cwd !== "" && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

function withRange(path: string, input: JSONValue): string {
  const offset = jint(jget(input, "offset"));
  const limit = jint(jget(input, "limit"));
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  return limit === undefined ? `${path}:${start}~` : `${path}:${start}-${start + limit - 1}`;
}

/** 바뀐 줄 수 — 결과 메타의 `structuredPatch` 가 있으면 그것, 없으면 입력의 앞뒤 글로 센다 */
function changeCount(name: string, input: JSONValue, meta: JSONValue | undefined): string | undefined {
  const hunks = jarr(jget(meta, "structuredPatch"));
  if (hunks !== undefined) {
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      for (const line of jarr(jget(hunk, "lines")) ?? []) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
    return `+${added} −${removed}`;
  }
  const edits = name === "MultiEdit" ? jarr(jget(input, "edits")) ?? [] : [input];
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const before = jstr(jget(edit, "old_string"));
    const after = jstr(jget(edit, "new_string"));
    if (before === undefined || after === undefined) continue;
    removed += lineCount(before);
    added += lineCount(after);
  }
  return added === 0 && removed === 0 ? undefined : `+${added} −${removed}`;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function joined(head: string, tail: string | undefined): string {
  return tail === undefined || tail === "" ? head : `${head} · ${tail}`;
}

export function firstLine(text: string, limit = 160): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function firstStringValue(input: JSONValue): string {
  const object = jobj(input);
  if (object === undefined) return "";
  for (const value of Object.values(object)) {
    if (typeof value === "string" && value.trim() !== "") return firstLine(value);
  }
  return "";
}
