import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeAttachments, splitAttachments } from "../src/session/attachments.ts";
import { ConversationReducer, newConversationModel, lastMessageLine, type ConversationModel } from "../src/session/conversation.ts";
import { jget, jstr, type JSONValue } from "../src/session/json-value.ts";
import { DENY_AND_STOP_MESSAGE, decisionFor, newPermissionPending, type PermissionPending } from "../src/session/pending.ts";
import { forkDirectivePrompt, parseNativeCommand } from "../src/session/commands.ts";
import { activeBranch, replayTranscript, rewindPointsFromEntries, transcriptTitles } from "../src/session/transcript.ts";
import { lifecycleOf, toViewItem } from "../src/session/view.ts";
import { decodeInbound } from "../src/session/wire.ts";

/** 실측 픽스처(CLI 2.1.287 캡처)를 데몬과 같은 길로 먹인다 — CLI 의 권한 요청은 SDK 에서 `canUseTool` 이다 */
function run(name: string): ConversationModel {
  const model = newConversationModel();
  const lines = readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n").filter((line) => line !== "");
  let localID = 0;
  for (const line of lines) {
    const { dir, msg } = JSON.parse(line) as { dir: string; msg: JSONValue };
    const type = jstr(jget(msg, "type"));
    if (dir === "in" && type === "user") {
      const content = jget(msg, "message", "content");
      const text = typeof content === "string" ? content : "";
      ConversationReducer.apply({ kind: "localUser", id: `local-${localID++}`, text }, model);
    } else if (dir === "out" && type === "control_request") {
      const request = jget(msg, "request");
      if (jstr(jget(request, "subtype")) !== "can_use_tool") continue;
      const pending = newPermissionPending(jstr(jget(msg, "request_id"))!, {
        toolName: jstr(jget(request, "tool_name"))!, input: jget(request, "input") ?? {},
        toolUseID: jstr(jget(request, "tool_use_id")), suggestions: (jget(request, "permission_suggestions") as JSONValue[] | undefined) ?? [],
      }, 0);
      ConversationReducer.apply({ kind: "pending", pending }, model);
    } else if (dir === "in" && type === "control_response") {
      ConversationReducer.apply({ kind: "resolved", requestID: jstr(jget(msg, "response", "request_id"))! }, model);
    } else if (dir === "out") {
      ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound(msg) }, model);
    }
  }
  return model;
}

describe("대화 리듀서 — 실측 픽스처", () => {
  test("두 턴 — 스트리밍 글이 최종 블록으로 굳고 턴 통계가 남는다", () => {
    const model = run("plain-two-turns.jsonl");
    const assistants = model.items.filter((item) => item.content.kind === "assistant");
    expect(assistants.length).toBe(2);
    expect(assistants.every((item) => item.content.kind === "assistant" && !item.content.isStreaming)).toBe(true);
    expect(model.items.filter((item) => item.content.kind === "notice" && item.content.notice.kind === "turnStats").length).toBe(2);
    expect(model.status.isTurnActive).toBe(false);
    expect(model.status.totalCostUSD).toBeGreaterThan(0);
  });

  test("권한 요청 — 도구 카드가 기다림이 됐다가 결과로 끝나고 할 일 목록이 모인다", () => {
    const model = run("default-mode-edit-tasks.jsonl");
    expect(model.pending.length).toBe(0);
    const edit = model.items.find((item) => item.content.kind === "tool" && item.content.call.name === "Edit");
    expect(edit?.content.kind === "tool" && edit.content.call.state).toBe("succeeded");
    expect(toViewItem(edit!, "/tmp/wire/sandbox").tool?.line).toBe("note.txt · +1 −1");
    expect(model.tasks.map((task) => [task.subject, task.status])).toEqual([["Edit note", "completed"], ["Verify", "completed"]]);
    expect(lastMessageLine(model)).toStartWith("Done.");
  });

  test("질문 — AskUserQuestion 이 질문 카드가 된다", () => {
    const model = newConversationModel();
    const pending = newPermissionPending("r1", {
      toolName: "AskUserQuestion", suggestions: [],
      input: { questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }] },
    }, 0);
    expect(pending.kind).toBe("question");
    ConversationReducer.apply({ kind: "pending", pending }, model);
    expect(lifecycleOf(model, { alive: true, starting: false, failed: false })).toBe("waitingQuestion");
    const decision = decisionFor(pending, { kind: "answer", answers: { "Which color?": "Red" } });
    expect(decision?.behavior === "allow" && decision.updatedInput.answers).toEqual({ "Which color?": "Red" });
  });

  test("백그라운드 작업 — 서브에이전트 카드가 진행·끝을 받는다", () => {
    const model = run("background-work.jsonl");
    const agents = model.items.filter((item) => item.content.kind === "tool" && item.content.call.name === "Agent");
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((item) => item.content.kind === "tool" && item.content.call.subagent?.status === "completed")).toBe(true);
    // 서브에이전트 안쪽 항목은 부른 카드에 매달린다
    expect(model.items.some((item) => item.parentToolUseID !== undefined)).toBe(true);
  });

  test("압축 — 구분선 하나", () => {
    const model = run("compact.jsonl");
    expect(model.items.filter((item) => item.content.kind === "notice" && item.content.notice.kind === "compacted").length).toBe(1);
  });

  test("백그라운드 작업 목록 — 실측 줄에서 id·종류·설명을 쥐고, 끝나면 비운다", () => {
    const lines = readFileSync(join(import.meta.dir, "fixtures", "background-work.jsonl"), "utf8").split("\n").filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { msg: JSONValue }).msg)
      .filter((msg) => jstr(jget(msg, "subtype")) === "background_tasks_changed");
    const model = newConversationModel();
    let widest: string[] = [];
    for (const msg of lines) {
      ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound(msg) }, model);
      const ids = (model.status.backgroundTasks ?? []).map((task) => task.id);
      if (ids.length > widest.length) widest = ids;
    }
    expect(widest.length).toBe(3);
    expect(model.status.backgroundTasks?.find((task) => task.type === "local_bash")).toBeUndefined();
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "b1", task_type: "local_bash", description: "Background sleep" }, { task_id: "w1", task_type: "monitor", ambient: true },
    ] }) }, model);
    expect(model.status.backgroundTasks).toEqual([{ id: "b1", type: "local_bash", description: "Background sleep" }]);
    ConversationReducer.apply({ kind: "processExited", code: 0 }, model);
    expect(model.status.backgroundTasks).toBeUndefined();
  });
});

describe("상태 줄 — 노력도·빠른 모드·컨텍스트 창", () => {
  test("init 과 result 의 빠른 모드 상태, init 의 노력도(키가 있을 때만)", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-5-5", permissionMode: "default", slash_commands: [],
      fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required",
    }) }, model);
    expect(model.status.fastMode).toEqual({ state: "off", disabledReason: "sdk_opt_in_required" });
    expect(model.status.effort).toBeUndefined();
    ConversationReducer.apply({ kind: "appliedSettings", model: "claude-sonnet-5-5", effort: "high" }, model);
    expect(model.status.effort).toBe("high");
    // init 이 노력도를 싣지 않으면 쥔 값을 지키고, null 을 실으면 지운다
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({ type: "system", subtype: "init", slash_commands: [] }) }, model);
    expect(model.status.effort).toBe("high");
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({ type: "system", subtype: "init", slash_commands: [], effort: null }) }, model);
    expect(model.status.effort).toBeUndefined();
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "result", subtype: "success", is_error: false, num_turns: 1, fast_mode_state: "on",
    }) }, model);
    expect(model.status.fastMode).toEqual({ state: "on" });
    // 노력도를 받지 않는 모델(Haiku 4.5)로 바뀌면 적용값이 없다
    ConversationReducer.apply({ kind: "appliedSettings", model: "claude-haiku-4-5-20251001", effort: null }, model);
    expect([model.status.model, model.status.effort]).toEqual(["claude-haiku-4-5-20251001", undefined]);
  });

  test("컨텍스트 창 — 쓴 양과 창 크기를 쥐고 다음 응답의 사용량이 쓴 양을 갈아 끼운다", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "contextUsage", used: 23_158, window: { max: 1_000_000, autoCompactAt: 967_000 } }, model);
    expect([model.status.contextTokens, model.status.contextWindow]).toEqual([23_158, { max: 1_000_000, autoCompactAt: 967_000 }]);
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "assistant", parent_tool_use_id: null,
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: 30_000, output_tokens: 5 } },
    }) }, model);
    expect(model.status.contextTokens).toBe(30_010);
  });

  test("서브에이전트의 글·생각·API 오류는 부른 카드 아래에 매달린다(forwardSubagentText)", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "assistant", parent_tool_use_id: null,
      message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "look" } }] },
    }) }, model);
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "assistant", parent_tool_use_id: "agent-1",
      message: { id: "s1", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "found it" }] },
    }) }, model);
    ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound({
      type: "assistant", parent_tool_use_id: "agent-1", isApiErrorMessage: true,
      message: { id: "s2", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: overloaded" }] },
    }) }, model);
    const nested = model.items.filter((item) => item.parentToolUseID === "agent-1").map((item) => item.content.kind);
    expect(nested).toEqual(["thinking", "assistant", "notice"]);
    // 서브에이전트의 글은 목록의 마지막 줄이 되지 않는다
    expect(lastMessageLine(model)).toBeUndefined();
  });
});

describe("권한 답", () => {
  const permission = newPermissionPending("p1", {
    toolName: "Bash", input: { command: "rm -rf build" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
  }, 0) as PermissionPending;

  test("이유 없이 거절하면 턴을 멈추고 이유가 있으면 그 말을 준다", () => {
    expect(decisionFor(permission, { kind: "deny" })).toEqual({ behavior: "deny", message: DENY_AND_STOP_MESSAGE, interrupt: true });
    const withReason = decisionFor(permission, { kind: "deny", reason: "build 는 남겨 둬" });
    expect(withReason?.behavior === "deny" && withReason.interrupt).toBeUndefined();
    expect(withReason?.behavior === "deny" && withReason.message.endsWith("build 는 남겨 둬")).toBe(true);
  });

  test("허용은 updatedInput 을 늘 채우고 세션 허용은 제안 규칙을 돌려준다", () => {
    expect(decisionFor(permission, { kind: "allow" })).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
    const session = decisionFor(permission, { kind: "allowSession" });
    expect(session?.behavior === "allow" && session.updatedPermissions).toEqual(permission.request.suggestions);
  });

  test("다시 묻지 않음을 막은 요청에는 세션 허용이 없다", () => {
    const suppressed = { ...permission, request: { ...permission.request, suppressAlwaysAllowRule: true } };
    expect(decisionFor(suppressed, { kind: "allowSession" })).toBeUndefined();
  });

  test("카드 종류에 맞지 않는 답은 받지 않는다", () => {
    expect(decisionFor(permission, { kind: "approvePlan" })).toBeUndefined();
  });
});

describe("기록 재생", () => {
  test("되감기가 낸 갈래는 끝 잎의 갈래만 읽고 custom-title 줄을 끝 잎으로 잡지 않는다", async () => {
    const entries: JSONValue[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "첫 질문" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "첫 답" }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "버린 질문" } },
      { type: "user", uuid: "u3", parentUuid: "a1", message: { role: "user", content: "다시 한 질문" } },
      { type: "custom-title", uuid: "t1", customTitle: "제목" },
    ];
    expect(activeBranch(entries).map((entry) => jstr(jget(entry, "uuid")))).toEqual(["u1", "a1", "u3"]);
    const model = await replayTranscript(entries);
    expect(model.items.map((item) => (item.content.kind === "user" || item.content.kind === "assistant" ? item.content.text : ""))).toEqual(["첫 질문", "첫 답", "다시 한 질문"]);
  });

  test("턴 도중에 쌓인 입력(queued_command)도 사람 말로 재생한다", async () => {
    const entries: JSONValue[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "하나" } },
      { type: "attachment", uuid: "q1", parentUuid: "u1", attachment: { type: "queued_command", commandMode: "prompt", prompt: "둘" } },
    ];
    expect((await replayTranscript(entries)).items.map((item) => item.content.kind === "user" && item.content.text)).toEqual(["하나", "둘"]);
  });

  test("제목은 custom-title → ai-title → 첫 프롬프트, 작업 폴더도 읽는다", () => {
    const lines = [
      JSON.stringify({ type: "user", cwd: "/p", message: { role: "user", content: "<command-name>/goal</command-name>\n<command-args>끝내자</command-args>" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "AI 제목" }),
    ];
    expect(transcriptTitles(lines)).toEqual({ cwd: "/p", firstPrompt: "/goal 끝내자", aiTitle: "AI 제목" });
  });
});

describe("첨부", () => {
  test("파일은 머리 한 줄에 @\"경로\" 로 잇고 다시 뗀다 — 따옴표는 지운다(데스크톱 모양)", () => {
    const text = composeAttachments("이거 봐 줘", ["/a/b c.txt", "/x/\"q\".md"]);
    expect(text).toBe("@\"/a/b c.txt\" @\"/x/q.md\"\n이거 봐 줘");
    expect(splitAttachments(text)).toEqual({ text: "이거 봐 줘", files: ["/a/b c.txt", "/x/q.md"], snippets: [] });
    expect(splitAttachments("본문 @\"/a\" 가운데")).toEqual({ text: "본문 @\"/a\" 가운데", files: [], snippets: [] });
  });

  test("예전 light 모양(경로마다 한 줄, 이스케이프)도 읽는다", () => {
    expect(splitAttachments("@\"/a/b.txt\"\n@\"/x/\\\"q\\\".md\"\n\n본문")).toEqual({ text: "본문", files: ["/a/b.txt", "/x/\"q\".md"], snippets: [] });
  });

  test("인용은 attach 주석과 > 줄로 싣고 다시 뗀다", () => {
    const text = composeAttachments("왜 그래?", ["/f.txt"], [{ label: "Claude 의 답 -->|x", text: "첫 줄\n둘째 줄" }]);
    expect(text).toBe("@\"/f.txt\"\n<!-- attach: Claude 의 답 x -->\n> 첫 줄\n> 둘째 줄\n\n왜 그래?");
    expect(splitAttachments(text)).toEqual({ text: "왜 그래?", files: ["/f.txt"], snippets: [{ label: "Claude 의 답 x", text: "첫 줄\n둘째 줄" }] });
    expect(splitAttachments(composeAttachments("", [], [{ text: "인용만" }]))).toEqual({ text: "", files: [], snippets: [{ text: "인용만" }] });
  });
});

/** 통신으로 온 메시지 한 줄을 먹인다 */
function feed(model: ConversationModel, message: Record<string, unknown>, quiet = false): void {
  ConversationReducer.apply({ kind: "inbound", inbound: decodeInbound(message as JSONValue), ...(quiet ? { quiet: true } : {}) }, model);
}

function assistantTool(name: string, input: Record<string, unknown>, id: string): Record<string, unknown> {
  return { type: "assistant", message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null };
}

describe("턴 도구", () => {
  test("update_plan 이 할 일 띠를 고치고 wrap_up 이 끝낸 뒤 상자가 상태와 화면 항목에 선다", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "localUser", id: "u", text: "고쳐 줘" }, model);
    feed(model, assistantTool("mcp__turn__update_plan", { scope: "first_task", items: [{ content: "읽기", status: "in_progress" }, { content: "고치기", status: "pending" }] }, "t1"));
    expect(model.tasks.map((task) => [task.subject, task.status])).toEqual([["읽기", "in_progress"], ["고치기", "pending"]]);
    feed(model, assistantTool("mcp__turn__update_plan", { advance: true }, "t2"));
    expect(model.tasks.map((task) => task.status)).toEqual(["completed", "in_progress"]);
    feed(model, assistantTool("mcp__turn__wrap_up", { recap: "고쳤습니다.", ask: "커밋할까요?", actions: [{ label: "커밋", message: "커밋해 줘" }, { label: "아니요" }] }, "t3"));
    expect(model.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(model.status.wrapUp).toEqual({ recap: "고쳤습니다.", ask: "커밋할까요?", actions: [{ label: "커밋", message: "커밋해 줘" }, { label: "아니요", message: "아니요" }] });
    const view = toViewItem(model.items.at(-1)!);
    expect(view.tool?.wrapUp?.recap).toBe("고쳤습니다.");
    // 다음 턴이 시작하면 상자는 알림 본문에서 내려간다
    ConversationReducer.apply({ kind: "localUser", id: "u2", text: "커밋해 줘" }, model);
    expect(model.status.wrapUp).toBeUndefined();
  });
});

describe("폰 명령과 이어 가기 줄", () => {
  test("명령 해석 — 첨부 없는 /btw·/fork·/subtask·/background·!", () => {
    expect(parseNativeCommand("/btw 이게 뭐야")).toEqual({ kind: "btw", question: "이게 뭐야" });
    expect(parseNativeCommand("/subtask 테스트 돌려")).toEqual({ kind: "fork", name: "subtask", directive: "테스트 돌려" });
    expect(parseNativeCommand("/background")).toEqual({ kind: "background" });
    expect(parseNativeCommand("/background 지금")).toBeUndefined();
    expect(parseNativeCommand("!  git status ")).toEqual({ kind: "shell", command: "git status" });
    expect(parseNativeCommand("/compact")).toBeUndefined();
    expect(parseNativeCommand("btw 아님")).toBeUndefined();
  });

  test("fork 지시는 사람이 친 모양으로, 데몬의 이어 가기 턴은 안내 줄로 그린다(실시간과 재생 둘 다)", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "localUser", id: "u", text: forkDirectivePrompt("파일 세기") }, model);
    feed(model, { type: "user", message: { role: "user", content: [{ type: "text", text: forkDirectivePrompt("다시 세기") }] }, parent_tool_use_id: null });
    feed(model, { type: "user", message: { role: "user", content: [{ type: "text", text: "The app was quit while you were working. Please continue from where you left off." }] }, origin: { kind: "auto-continuation" } });
    ConversationReducer.apply({ kind: "localAutoContinue", display: "Mac 이 잠든 사이 끊긴 작업을 이어 갑니다." }, model);
    expect(model.items.map((item) => (item.content.kind === "user" ? item.content.text : item.content.kind === "notice" ? item.content.notice.text : ""))).toEqual([
      "/fork 파일 세기", "/fork 다시 세기", "Mac 의 light 가 꺼진 사이 멈춘 작업을 이어 갑니다.", "Mac 이 잠든 사이 끊긴 작업을 이어 갑니다.",
    ]);
    expect(model.status.isTurnActive).toBe(true);
  });

  test("! 셸 줄 — 명령은 사람 말, 출력은 이스케이프를 푼 고정폭 줄. 빈 init·result 는 턴을 열고 닫지 않는다", () => {
    const model = newConversationModel();
    ConversationReducer.apply({ kind: "localContext", text: "<bash-input>ls</bash-input>" }, model);
    feed(model, { type: "system", subtype: "init", session_id: "s", model: "m", slash_commands: ["compact"] }, true);
    expect(model.status.isTurnActive).toBe(false);
    feed(model, { type: "result", subtype: "success", is_error: false, num_turns: 0, session_id: "s" }, true);
    ConversationReducer.apply({ kind: "localContext", text: "<bash-stdout>a&lt;b&gt;&amp;c</bash-stdout><bash-stderr>warn</bash-stderr>" }, model);
    expect(model.items.map((item) => item.content)).toEqual([
      { kind: "user", text: "! ls" },
      { kind: "notice", notice: { kind: "shell", text: "a<b>&c\nwarn" } },
    ]);
    expect(model.status.slashCommands).toEqual(["compact"]);
  });

  test("사람 턴의 PDF 문서 블록은 파일 칩이 된다", () => {
    const model = newConversationModel();
    feed(model, { type: "user", message: { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "명세.pdf" }, { type: "text", text: "읽어 줘" }] }, parent_tool_use_id: null });
    expect(model.items[0]).toMatchObject({ content: { kind: "user", text: "읽어 줘" }, files: ["명세.pdf"] });
  });
});

describe("되감을 자리", () => {
  test("지금 갈래의 사람 메시지만 — 도구 결과·이어 가기·셸 줄은 빼고, 첨부 머리는 떼고, 앞 assistant 를 단다", () => {
    const entries: JSONValue[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "첫째" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
      { type: "user", uuid: "r1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
      { type: "assistant", uuid: "a2", parentUuid: "r1", message: { role: "assistant", content: [{ type: "text", text: "끝" }] } },
      { type: "user", uuid: "s1", parentUuid: "a2", message: { role: "user", content: "<bash-input>ls</bash-input>" } },
      { type: "user", uuid: "c1", parentUuid: "s1", origin: { kind: "auto-continuation" }, message: { role: "user", content: "The app was quit while you were working. Please continue from where you left off." } },
      { type: "user", uuid: "u2", parentUuid: "c1", timestamp: "2026-10-22T01:02:03.000Z", message: { role: "user", content: [{ type: "text", text: "@\"/x/a.txt\"\n둘째" }] } },
      // 버려진 갈래 — 끝 잎이 아니다
      { type: "user", uuid: "old", parentUuid: "a2", message: { role: "user", content: "버린 말" } },
      { type: "assistant", uuid: "a3", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "응" }] } },
    ];
    expect(rewindPointsFromEntries(entries)).toEqual([
      { id: "u2", text: "둘째", timestamp: Date.parse("2026-10-22T01:02:03.000Z"), resumeAt: "a2" },
      { id: "u1", text: "첫째" },
    ]);
  });

  test("앞이 잘린 기록의 첫 메시지는 자리가 아니다", () => {
    const entries: JSONValue[] = [
      { type: "user", uuid: "u5", parentUuid: "gone", message: { role: "user", content: "잘린 뒤 첫 말" } },
      { type: "assistant", uuid: "a5", parentUuid: "u5", message: { role: "assistant", content: [{ type: "text", text: "응" }] } },
      { type: "user", uuid: "u6", parentUuid: "a5", message: { role: "user", content: "다음" } },
    ];
    expect(rewindPointsFromEntries(entries).map((point) => point.id)).toEqual(["u6"]);
  });
});
