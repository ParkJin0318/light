/**
 * 턴 도구 서버(`mcp__turn__*`) — 모든 세션에 싣는다(`options.ts`).
 * 화면의 할 일 띠와 상자는 리듀서가 도구 호출에서 만든다(`shared/src/session/turn-box.ts`) — 여기는 입력을 검사하고 세션에 결과 문장을 돌려줄 뿐이다.
 * 검사는 서버가 쥔 목록 사본으로 한다: 도구가 불릴 때는 리듀서가 그 호출을 이미 적용한 뒤라 세션의 목록을 보면 두 번 적용한 값이 된다
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskEntry } from "../../../shared/src/session/conversation.ts";
import type { JSONValue } from "../../../shared/src/session/json-value.ts";
import {
  TURN_LIMITS, TURN_MCP_SERVER, UPDATE_PLAN_DESCRIPTION, UPDATE_PLAN_TOOL, WRAP_UP_DESCRIPTION, WRAP_UP_TOOL, applyPlanUpdate, completePlan, wrapUpContent,
} from "../../../shared/src/session/turn-box.ts";

const toolText = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/** 세션 하나의 서버 — `seed` 는 이어 연 대화의 목록(기록에서 다시 만든 것) */
export function turnMcpServer(seed: readonly TaskEntry[] = []): McpSdkServerConfigWithInstance {
  const tasks: TaskEntry[] = seed.filter((task) => task.id.startsWith("plan-")).map((task) => ({ ...task }));
  return createSdkMcpServer({
    name: TURN_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(UPDATE_PLAN_TOOL, UPDATE_PLAN_DESCRIPTION, {
        scope: z.enum(["first_task", "continuation", "new_task"]).optional()
          .describe("Required with items: \"first_task\", \"continuation\" or \"new_task\" (see the tool description). Omit on advance / done / start updates."),
        items: z.array(z.object({
          content: z.string().describe("The step, as a short imperative phrase (≤7 words)."),
          status: z.enum(["pending", "in_progress", "completed"]),
        })).optional().describe(`The whole plan, in order (1–${TURN_LIMITS.steps} steps); replaces the previous list. Use on the first call and whenever the plan changes.`),
        advance: z.boolean().optional().describe("true: the in_progress step is done and the next pending step starts (the cheap, usual update)."),
        done: z.array(z.number().int()).optional().describe("1-based numbers of steps just completed (out-of-order updates)."),
        start: z.number().int().optional().describe("1-based number of the step now in progress (with done, for out-of-order updates)."),
      }, async (args) => {
        if (args.items !== undefined && args.scope === undefined) {
          return toolText("items also needs \"scope\": \"first_task\", \"continuation\" or \"new_task\" — what this request is to the session. Send the same items again with it.", true);
        }
        const result = applyPlanUpdate(tasks, args as unknown as JSONValue);
        return result.ok ? toolText(result.summary) : toolText(result.error, true);
      }, { alwaysLoad: true }),
      tool(WRAP_UP_TOOL, WRAP_UP_DESCRIPTION, {
        recap: z.string().describe(`Two or three short sentences to the user (≤${TURN_LIMITS.recap} chars): what is now true or changed, then where it stands.`),
        ask: z.string().optional().describe(`The one question (≤${TURN_LIMITS.ask} chars) when the next move is the user's call — a choice, a go-ahead, an approval — naming your pick (actions[0]) and why. Omit it, and actions, when nothing waits on the user.`),
        blocked: z.boolean().optional().describe("true when your work stops here until the user answers; omit when the answer can wait."),
        actions: z.array(z.object({
          label: z.string().describe(`The button text, 1–3 words / ${TURN_LIMITS.label} characters — "Yes, fix 1", "Not now".`),
          message: z.string().optional().describe(`What the tap sends, up to ${TURN_LIMITS.message} characters of plain text. Omit when the label is the whole message.`),
        })).optional().describe(`1–${TURN_LIMITS.actions} buttons, recommendation first. They are answers to your ask: the first accepts your recommendation, and another is there only when it is a realistic alternative.`),
      }, async (args) => {
        const box = wrapUpContent(args as unknown as JSONValue);
        if (box === undefined) return toolText("recap is required: what is now true or changed and where it stands, said to the user in two or three sentences.", true);
        completePlan(tasks);
        return toolText(box.ask !== undefined
          ? "Box shown with your question and buttons. Write your closing message now, as the last thing you say this turn; do not repeat the question."
          : "Recap shown. Write your closing message now, as the last thing you say this turn, with only the detail the recap does not carry.");
      }, { alwaysLoad: true }),
    ],
  });
}
