/**
 * 턴 도구 — 데스크톱 앱의 `ccd_turn` 과 같은 둘이다. 데몬이 모든 세션에 싣는다
 * (`daemon/src/session/turn-tools.ts`).
 *
 * - `update_plan`: 머리의 할 일 띠를 세션이 직접 쥔다. 리듀서가 호출마다 목록을 고치므로 재개한 대화도 기록만으로 같은 목록이 된다
 * - `wrap_up`: 턴 끝의 「다음 단계」 상자 — 요약(recap)과, 사람이 정할 일이 있으면 질문 하나와 답 단추. 대화 속 그 호출 자리에 그리고
 *   턴 완료 알림의 본문이 된다. 부르면 할 일을 모두 끝낸 것으로 친다
 *
 * light 에는 변경 패널이 없어 앱 동작 단추(커밋·PR 만들기)를 뺐다. 단추는 누르면 그 글을 보내는 답뿐이다
 */
import type { TaskEntry } from "./conversation.ts";
import { jarr, jbool, jget, jint, jstr, type JSONValue } from "./json-value.ts";

export const TURN_MCP_SERVER = "turn";
export const UPDATE_PLAN_TOOL = "update_plan";
export const WRAP_UP_TOOL = "wrap_up";
export const UPDATE_PLAN_FULL_NAME = `mcp__${TURN_MCP_SERVER}__${UPDATE_PLAN_TOOL}`;
export const WRAP_UP_FULL_NAME = `mcp__${TURN_MCP_SERVER}__${WRAP_UP_TOOL}`;

/** 데스크톱의 상한 — 할 일 12단계, 요약 300자, 질문 180자, 단추 2개·이름 24자·보낼 글 300자 */
export const TURN_LIMITS = { steps: 12, recap: 300, ask: 180, actions: 2, label: 24, message: 300 } as const;

export const UPDATE_PLAN_DESCRIPTION = [
  "Keep the task list the app shows above the conversation while you work: the user follows your progress by it and will never ask for it, so it is part of the task. Every request that edits files or runs more than one command gets one (implement-and-test, investigate-then-fix, anything the user listed); only a single-command answer or pure conversation does not.",
  "",
  "Never spend a message on this tool alone: send it IN THE SAME MESSAGE as another tool call (in parallel), so it costs no extra round trip.",
  "- First call: with the VERY FIRST tool call of the turn, even one that only reads or lists files: {\"items\": [...]}, the whole plan in order, short imperative phrases in the language the user writes in (at most ~7 words, no numbering), the step you are starting \"in_progress\", the rest \"pending\". If you must look around first, make \"Look at how X is set up\" step one and refine the list once you know.",
  "- Next step: {\"advance\": true} alongside the call that begins it (completes the in_progress step, starts the next pending one); after the last step, advance alongside wrap_up.",
  "- Out of order: {\"done\": [2], \"start\": 4} (1-based).",
  "- Plan changed, including right after the user interrupts or sends a new instruction mid-task: {\"items\": [...]} again, the new whole list, so the pinned list never shows an abandoned plan.",
  "- Every {\"items\"} call says in \"scope\" what this request is to the session: \"first_task\" (nothing finished here yet); after that, \"new_task\" (unrelated work: it builds on nothing done, found or decided here) or \"continuation\" (everything else; when unsure, this one).",
  "Keep exactly one step in_progress while working and none when everything is done. Do not also write the plan as a numbered list in your message: the pinned list is the plan.",
].join("\n");

export const WRAP_UP_DESCRIPTION = [
  "Fill the \"next step\" box the app shows at the end of your turn: a two-or-three-sentence recap and, when this turn leaves the user a decision to make or a step to take, one question and buttons that answer it; a turn with nothing pending ends with the recap alone. The recap is also the notification the user's phone shows when the turn ends. Call it once in EVERY turn in which you kept a task list, changed files, ran commands, or completed multi-step work: when this turn's work is done and before your closing message (it also checks off the task list; no closing update_plan is needed). Skip it for short answers, pure conversation, or a brief read-and-explain turn — a reply that names a follow-up is not brief: propose it and call this.",
  "",
  "Your closing message is ordinary text right after this call, the last thing you say this turn: only detail the recap does not carry — what changed and how to check it, what failed and what you did about it, what you did not run or verify; files, commands, numbers, most important first, about 120 words at most — or, with none, the turn ends on the call.",
  "",
  "Fields — recap and ask are said to the user, in the second person; a button's label and message are the user's words back to you. Write every field in the language the user writes in:",
  `- recap: what is now true or changed, then where it stands (for example: nothing committed, or not verified in the app). Two or three short sentences, about 40 words / ${TURN_LIMITS.recap} characters, in the project's own words. No recommendation here.`,
  `- ask (with actions, only when the next move is the user's call — a choice of approach, a go-ahead to commit, push, post or send, an approval): that ONE question in one sentence, never two joined by "and", naming your pick (it must be actions[0]) and its one-clause reason ("Start with fix 1, since fix 2 builds on it?"). At most ${TURN_LIMITS.ask} characters.`,
  "Every field is a top-level parameter holding plain prose (actions: a JSON array); none contains markup or another field.",
].join("\n");

/** 상자의 답 단추 — 누르면 `message` 를 보낸다 */
export interface TurnAction {
  label: string;
  message: string;
}

export interface TurnWrapUp {
  recap: string;
  ask?: string;
  /** 사람이 답할 때까지 일이 멈춘다 */
  blocked?: boolean;
  actions: TurnAction[];
}

function taskStatus(raw: string | undefined): TaskEntry["status"] | undefined {
  return raw === "pending" || raw === "in_progress" || raw === "completed" ? raw : undefined;
}

/** 1부터 센 단계 번호가 목록 안인가 */
function isStep(value: number | undefined, count: number): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= count;
}

/**
 * `update_plan` 의 입력을 목록에 적용한다 — 데스크톱과 같은 셋: 통째로(`items`), 다음 단계로(`advance`), 순서 밖(`done`·`start`).
 * 틀린 입력이면 고치지 않고 그 까닭을 돌려준다(세션이 읽고 다시 보낸다)
 */
export function applyPlanUpdate(tasks: TaskEntry[], input: JSONValue): { ok: true; summary: string } | { ok: false; error: string } {
  const items = jarr(jget(input, "items"));
  if (items !== undefined) {
    const steps = items.flatMap((item): TaskEntry[] => {
      const content = jstr(jget(item, "content"))?.trim();
      if (content === undefined || content === "") return [];
      return [{ id: "", subject: content, status: taskStatus(jstr(jget(item, "status"))) ?? "pending" }];
    }).slice(0, TURN_LIMITS.steps).map((step, index) => ({ ...step, id: `plan-${index + 1}` }));
    if (steps.length === 0) return { ok: false, error: "items needs at least one step with content and status." };
    tasks.splice(0, tasks.length, ...steps);
    const working = steps.filter((step) => step.status === "in_progress").length;
    return { ok: true, summary: `Plan shown (${steps.length} steps).${working > 1 ? " Keep only one step in_progress." : ""}` };
  }
  const done = (jarr(jget(input, "done")) ?? []).map((value) => (typeof value === "number" ? value : Number.NaN));
  const start = jint(jget(input, "start"));
  const advance = jbool(jget(input, "advance")) === true || jstr(jget(input, "advance")) === "true";
  if (!advance && done.length === 0 && start === undefined) {
    return { ok: false, error: "Pass {\"items\": [...]} (whole plan), {\"advance\": true}, or {\"done\": [n], \"start\": m}." };
  }
  const count = tasks.length;
  if ([...done, ...(start !== undefined ? [start] : [])].some((value) => !isStep(value, count === 0 ? TURN_LIMITS.steps : count))) {
    return { ok: false, error: "Nothing changed: done and start take whole step numbers counted from 1. Send the update again with numbers that name a step, or the whole list ({\"items\": [...]}) if the plan changed." };
  }
  for (const value of done) if (isStep(value, count)) tasks[value - 1] = { ...tasks[value - 1]!, status: "completed" };
  if (isStep(start, count)) tasks[start - 1] = { ...tasks[start - 1]!, status: "in_progress" };
  if (advance) {
    const current = tasks.findIndex((task) => task.status === "in_progress");
    if (current >= 0) tasks[current] = { ...tasks[current]!, status: "completed" };
    const after = tasks.findIndex((task, index) => index > current && task.status === "pending");
    const next = after >= 0 ? after : tasks.findIndex((task) => task.status === "pending");
    if (next >= 0) tasks[next] = { ...tasks[next]!, status: "in_progress" };
  }
  const working = tasks.flatMap((task, index) => (task.status === "in_progress" ? [index + 1] : []));
  const finished = tasks.filter((task) => task.status === "completed").length;
  const where = working.length === 1 ? `step ${working[0]} of ${count} is in progress`
    : finished === count ? "every step is done" : `no step is in progress (${finished} of ${count} done)`;
  return { ok: true, summary: `Plan updated: ${where}.` };
}

/** `wrap_up` 가 할 일을 모두 끝낸 것으로 친다 */
export function completePlan(tasks: TaskEntry[]): void {
  for (let index = 0; index < tasks.length; index += 1) {
    if (tasks[index]!.id.startsWith("plan-")) tasks[index] = { ...tasks[index]!, status: "completed" };
  }
}

function clip(text: string | undefined, limit: number): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const characters = [...trimmed];
  return characters.length <= limit ? trimmed : `${characters.slice(0, limit - 1).join("")}…`;
}

/** `wrap_up` 의 입력 → 상자. 요약이 없으면 undefined(세션에 다시 쓰라고 답한다) */
export function wrapUpContent(input: JSONValue): TurnWrapUp | undefined {
  const recap = clip(jstr(jget(input, "recap")), TURN_LIMITS.recap);
  if (recap === undefined) return undefined;
  const ask = clip(jstr(jget(input, "ask")), TURN_LIMITS.ask);
  const actions = (jarr(jget(input, "actions")) ?? []).flatMap((entry): TurnAction[] => {
    const label = clip(jstr(jget(entry, "label")), TURN_LIMITS.label);
    if (label === undefined) return [];
    return [{ label, message: clip(jstr(jget(entry, "message")), TURN_LIMITS.message) ?? label }];
  }).slice(0, TURN_LIMITS.actions);
  return {
    recap,
    ...(ask !== undefined ? { ask } : {}),
    ...(jbool(jget(input, "blocked")) === true ? { blocked: true } : {}),
    // 질문이 없으면 단추도 없다 — 답할 것이 없다
    actions: ask === undefined ? [] : actions,
  };
}

/** 시스템 프롬프트 끝에 붙이는 사용 규칙 — 데스크톱 앱이 제 도구의 규칙을 붙이는 자리와 같다 */
export const TURN_SYSTEM_PROMPT = [
  "This app shows a pinned task list and an end-of-turn \"next step\" box for this session.",
  `Keep the task list with ${UPDATE_PLAN_FULL_NAME} (instead of TodoWrite) and close every turn that changed files, ran commands or did multi-step work with ${WRAP_UP_FULL_NAME} before your closing message.`,
].join(" ");
