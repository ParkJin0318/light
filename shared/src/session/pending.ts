/**
 * 사람의 답을 기다리는 CLI 요청 한 건.
 * 권한 요청·AskUserQuestion·ExitPlanMode 는 모두 `canUseTool` 로 온다. MCP 입력 요청(elicitation)과
 * CLI 대화상자는 따로 온다. 응답 조립은 여기 한 곳이다: 허용에 `updatedInput` 이 빠지면 CLI 가 거부하고,
 * 질문을 `answers` 없이 허용하면 「답하지 않았다」로 처리된다(실측)
 */
import { jarr, jbool, jget, jobj, jstr, jstrings, type JSONObject, type JSONValue } from "./json-value.ts";
import { toolSummary } from "./tool-summary.ts";

export interface PermissionRequest {
  toolName: string;
  displayName?: string;
  input: JSONValue;
  toolUseID?: string;
  /** CLI 가 지은 권한 문장 전체 — 있으면 도구 이름·입력으로 다시 짓지 않는다 */
  title?: string;
  description?: string;
  decisionReason?: string;
  /** 「이 세션 동안 허용」에 쓸 규칙 — 그대로 `updatedPermissions` 로 돌려보내면 적용된다(실측) */
  suggestions: JSONValue[];
  /** 「다시 묻지 않음」을 내면 안 되는 요청 — 그 규칙이 이 요청보다 넓게 허용한다(d.ts) */
  suppressAlwaysAllowRule?: boolean;
  /** 서브에이전트 안에서 온 요청이면 그 에이전트 id */
  agentID?: string;
  blockedPath?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
  /** 고른 동안 보이는 미리보기(마크다운) */
  preview?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** elicitation 폼의 칸 하나 — `requestedSchema.properties` 의 원시 타입만 */
export interface ElicitationField {
  name: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  choices?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
}

export interface DialogChoice {
  id: string;
  label: string;
  detail?: string;
}

interface PendingBase {
  requestID: string;
  /** epoch 밀리초 */
  createdAt: number;
}

export type PendingInteraction =
  | (PendingBase & { kind: "permission"; request: PermissionRequest; summary: string })
  | (PendingBase & { kind: "question"; request: PermissionRequest; questions: Question[] })
  | (PendingBase & { kind: "planApproval"; request: PermissionRequest; plan: string })
  | (PendingBase & { kind: "elicitation"; serverName: string; message: string; mode?: string; url?: string; fields: ElicitationField[] })
  | (PendingBase & { kind: "dialog"; dialogKind: string; payload: JSONValue; title: string; detail?: string; choices: DialogChoice[] });

export type PermissionPending = Extract<PendingInteraction, { request: PermissionRequest }>;

export function isPermissionPending(pending: PendingInteraction): pending is PermissionPending {
  return pending.kind === "permission" || pending.kind === "question" || pending.kind === "planApproval";
}

/** 그 요청이 묶인 도구 호출 — 카드가 떠 있는 동안 도구 행이 「기다림」으로 보인다 */
export function pendingToolUseID(pending: PendingInteraction): string | undefined {
  return isPermissionPending(pending) ? pending.request.toolUseID : undefined;
}

/** 알림·목록이 묶는 갈래 — 질문과 계획 승인은 「질문 대기」, 나머지는 「승인 대기」 */
export function pendingCategory(pending: PendingInteraction): "permission" | "question" {
  return pending.kind === "question" || pending.kind === "planApproval" || pending.kind === "elicitation" ? "question" : "permission";
}

/** `cwd` 를 주면 요약의 경로를 그 아래 상대 경로로 줄인다 */
export function newPermissionPending(requestID: string, request: PermissionRequest, createdAt: number, cwd?: string): PermissionPending {
  switch (request.toolName) {
    case "AskUserQuestion": {
      const questions = (jarr(jget(request.input, "questions")) ?? []).flatMap((json) => {
        const parsed = questionFrom(json);
        return parsed === undefined ? [] : [parsed];
      });
      if (questions.length > 0) return { kind: "question", requestID, createdAt, request, questions };
      break;
    }
    case "ExitPlanMode":
      return { kind: "planApproval", requestID, createdAt, request, plan: jstr(jget(request.input, "plan")) ?? "" };
    default:
      break;
  }
  const summary = request.title ?? toolSummary(request.toolName, request.input, undefined, cwd).line;
  return { kind: "permission", requestID, createdAt, request, summary };
}

function questionFrom(json: JSONValue): Question | undefined {
  const text = jstr(jget(json, "question"));
  if (text === undefined) return undefined;
  const options: QuestionOption[] = [];
  for (const option of jarr(jget(json, "options")) ?? []) {
    const label = jstr(jget(option, "label"));
    if (label === undefined) continue;
    const description = jstr(jget(option, "description"));
    const preview = jstr(jget(option, "preview"));
    options.push({
      label, ...(description !== undefined ? { description } : {}),
      ...(preview !== undefined && preview.trim() !== "" ? { preview } : {}),
    });
  }
  const header = jstr(jget(json, "header"));
  return { question: text, ...(header !== undefined ? { header } : {}), options, multiSelect: jbool(jget(json, "multiSelect")) ?? false };
}

export function newElicitationPending(
  requestID: string, createdAt: number,
  elicitation: { serverName: string; message: string; mode?: string; url?: string; requestedSchema?: JSONValue },
): PendingInteraction {
  return {
    kind: "elicitation", requestID, createdAt, serverName: elicitation.serverName, message: elicitation.message,
    ...(elicitation.mode !== undefined ? { mode: elicitation.mode } : {}),
    ...(elicitation.url !== undefined ? { url: elicitation.url } : {}),
    fields: elicitationFields(elicitation.requestedSchema),
  };
}

function elicitationFields(schema: JSONValue | undefined): ElicitationField[] {
  const properties = jobj(jget(schema, "properties"));
  if (properties === undefined) return [];
  const required = new Set(jstrings(jget(schema, "required")));
  return Object.entries(properties).map(([name, property]): ElicitationField => {
    const rawType = jstr(jget(property, "type"));
    const values = jstrings(jget(property, "enum"));
    const names = jstrings(jget(property, "enumNames"));
    const type = rawType === "number" || rawType === "integer" || rawType === "boolean" ? rawType : "string";
    const description = jstr(jget(property, "description"));
    const fallback = jget(property, "default");
    const defaultValue = typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean" ? fallback : undefined;
    return {
      name, title: jstr(jget(property, "title")) ?? name, type, required: required.has(name),
      ...(description !== undefined ? { description } : {}),
      ...(values.length > 0 ? { choices: values.map((value, index) => ({ value, label: names[index] ?? value })) } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  });
}

/**
 * CLI 대화상자 — SDK 호스트에 오는 종류(2.1.300 바이너리). 거절 응답의 대체 모델 재시도와
 * 사용량 크레딧 모델 동의만 받는다. 선언하지 않은 종류는 오지 않는다(d.ts)
 */
export const SUPPORTED_DIALOG_KINDS = ["refusal_fallback_prompt", "fable_overage_consent_prompt"] as const;

export function newDialogPending(requestID: string, createdAt: number, dialogKind: string, payload: JSONValue): PendingInteraction {
  return { kind: "dialog", requestID, createdAt, dialogKind, payload, ...dialogSummary(dialogKind, payload) };
}

function dialogSummary(dialogKind: string, payload: JSONValue): { title: string; detail?: string; choices: DialogChoice[] } {
  switch (dialogKind) {
    case "refusal_fallback_prompt": {
      const original = jstr(jget(payload, "originalModel")) ?? "모델";
      const fallback = jstr(jget(payload, "fallbackModel")) ?? "대체 모델";
      const guidance = jstr(jget(payload, "guidanceText"));
      return {
        title: `${original}이 응답을 거절했습니다`,
        ...(guidance !== undefined && guidance.trim() !== "" ? { detail: guidance.trim() } : {}),
        choices: [
          { id: "retry_fallback", label: `${fallback}로 다시 답하기`, detail: "거절된 답을 거두고 대체 모델이 같은 요청에 답합니다" },
          { id: "edit_prompt", label: "프롬프트 고쳐 다시 보내기" },
        ],
      };
    }
    case "fable_overage_consent_prompt": {
      const model = jstr(jget(payload, "modelName")) ?? jstr(jget(payload, "model")) ?? "이 모델";
      return {
        title: `${model}은 사용량 크레딧으로 씁니다`,
        choices: [
          { id: "consent", label: `크레딧으로 ${model} 쓰기` },
          { id: "switch_default", label: "기본 모델로 바꾸기" },
        ],
      };
    }
    default:
      return { title: jstr(jget(payload, "title")) ?? dialogKind, choices: [] };
  }
}

// MARK: - 응답

/** 기기가 보내는 답 — 카드 종류마다 받는 것이 다르다(`decisionFor`) */
export type PendingAnswer =
  | { kind: "allow" }
  | { kind: "allowSession" }
  | { kind: "deny"; reason?: string }
  /** AskUserQuestion — 키는 질문 원문, 값은 고른 라벨(여럿이면 ", " 로 잇는다)이나 직접 친 글 */
  | { kind: "answer"; answers: Record<string, string> }
  /** 질문을 닫는다 — 글이 있으면 그 말을 Claude 에게 주고 턴이 이어진다 */
  | { kind: "dismiss"; reply?: string }
  | { kind: "approvePlan"; acceptEdits?: boolean }
  | { kind: "rejectPlan"; feedback?: string }
  | { kind: "elicitation"; action: "accept" | "decline" | "cancel"; content?: JSONObject }
  | { kind: "dialog"; choice?: string };

/** SDK `PermissionResult` 와 같은 모양 */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: JSONObject; updatedPermissions?: JSONValue[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** 이 세션 동안 허용을 낼 수 있는가 — CLI 가 제안한 규칙이 있고 막지 않았을 때만 */
export function canAllowForSession(pending: PermissionPending): boolean {
  return pending.request.suggestions.length > 0 && pending.request.suppressAlwaysAllowRule !== true;
}

/**
 * 터미널이 거부한 도구 호출에 돌려주는 글(2.1.300 바이너리) — 모델이 읽는 말이라 터미널과 같은 영어 원문이다.
 * 사유 없이 거부하면 턴을 멈추고 사람을 기다린다. 사유를 적으면 그 글을 받아 이어 간다
 */
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
export const DENY_AND_STOP_MESSAGE = `${REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`;
const DENY_WITH_FEEDBACK_PREFIX = `${REJECTED} To tell you how to proceed, the user said:\n`;
/** 서브에이전트 안의 거부 — 터미널은 멈추지 않고 다른 길을 찾게 한다 */
const SUBAGENT_DENIED = "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const SUBAGENT_DENY_MESSAGE = `${SUBAGENT_DENIED} Try a different approach or report the limitation to complete your task.`;
const SUBAGENT_DENY_WITH_FEEDBACK_PREFIX = `${SUBAGENT_DENIED} The user said:\n`;
const DEFAULT_PLAN_REJECT_MESSAGE = "The user did not approve the plan. Keep refining it.";

function inputObject(request: PermissionRequest): JSONObject {
  return { ...(jobj(request.input) ?? {}) };
}

export function deny(pending: PermissionPending, feedback?: string): PermissionDecision {
  const text = feedback?.trim() ?? "";
  if (pending.request.agentID !== undefined) {
    return { behavior: "deny", message: text === "" ? SUBAGENT_DENY_MESSAGE : `${SUBAGENT_DENY_WITH_FEEDBACK_PREFIX}${text}` };
  }
  if (text === "") return { behavior: "deny", message: DENY_AND_STOP_MESSAGE, interrupt: true };
  return { behavior: "deny", message: `${DENY_WITH_FEEDBACK_PREFIX}${text}` };
}

/** 계획 승인과 함께 편집 자동 수락으로 — 데스크톱 앱의 「승인하고 자동 편집」 */
const ACCEPT_EDITS_SUGGESTION: JSONValue = { type: "setMode", mode: "acceptEdits", destination: "session" };

/** 권한 카드 종류에 맞지 않는 답이면 undefined — 데몬이 거절한다 */
export function decisionFor(pending: PermissionPending, answer: PendingAnswer): PermissionDecision | undefined {
  switch (answer.kind) {
    case "allow":
      return pending.kind === "permission" ? { behavior: "allow", updatedInput: inputObject(pending.request) } : undefined;
    case "allowSession":
      if (pending.kind !== "permission" || !canAllowForSession(pending)) return undefined;
      return { behavior: "allow", updatedInput: inputObject(pending.request), updatedPermissions: pending.request.suggestions };
    case "deny":
      return pending.kind === "permission" ? deny(pending, answer.reason) : undefined;
    case "answer": {
      if (pending.kind !== "question") return undefined;
      const input = inputObject(pending.request);
      input.answers = { ...answer.answers };
      return { behavior: "allow", updatedInput: input };
    }
    case "dismiss":
      return pending.kind === "question" ? deny(pending, answer.reply) : undefined;
    case "approvePlan":
      if (pending.kind !== "planApproval") return undefined;
      return {
        behavior: "allow", updatedInput: inputObject(pending.request),
        ...(answer.acceptEdits === true ? { updatedPermissions: [ACCEPT_EDITS_SUGGESTION] } : {}),
      };
    case "rejectPlan": {
      if (pending.kind !== "planApproval") return undefined;
      const text = answer.feedback?.trim() ?? "";
      return { behavior: "deny", message: text === "" ? DEFAULT_PLAN_REJECT_MESSAGE : text };
    }
    case "elicitation":
    case "dialog":
      return undefined;
  }
}

/** 답이 오지 않은 채 세션이 끝났거나 CLI 가 거뒀다 — 안전한 쪽(거부) */
export const NO_ANSWER: PermissionDecision = { behavior: "deny", message: "The session ended before the user answered." };
