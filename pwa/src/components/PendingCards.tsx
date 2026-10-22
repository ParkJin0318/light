/**
 * 답을 기다리는 카드 — 도크 위에 노란 등 카드로 켜진다. 권한 요청은 도구 그림·이름과 한 줄 요약, 펼치면 원문.
 * 단추는 허용·이 세션 동안 허용·거절이고, 이유를 적어 거절하면 그 말이 Claude 에게 가고 턴이 이어진다.
 * 질문의 선택지는 진짜 라디오·체크 상자다(화살표 키·낭독기가 그대로 된다). 답한 카드는 짧게 빠져나가고,
 * 다른 기기가 먼저 답한 카드는 잠깐 「처리됨」으로 남았다가 사라진다
 */
import { Bot, Check, ChevronRight, Map, MessageCircleQuestion, Puzzle, SquareStack } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ElicitationField, PendingInteraction, PermissionPending, Question } from "../../../shared/src/session/pending.ts";
import { canAllowForSession } from "../../../shared/src/session/pending.ts";
import { connection } from "../connection.ts";
import { Markdown } from "../markdown.tsx";
import { useAppState } from "../store.ts";
import { Icon, toolIcon } from "./icons.tsx";

const LEAVE_MS = 150;

export function PendingStack({ sessionId, pending, focusCard }: { sessionId: string; pending: PendingInteraction[]; focusCard?: string }) {
  const answers = useAppState((state) => state.answers);
  const [ghosts, setGhosts] = useState<{ requestID: string; title: string }[]>([]);
  const [leaving, setLeaving] = useState<PendingInteraction[]>([]);
  const previous = useRef<PendingInteraction[]>(pending);
  useEffect(() => {
    const now = new Set(pending.map((item) => item.requestID));
    const gone = previous.current.filter((item) => !now.has(item.requestID));
    previous.current = pending;
    if (gone.length === 0) return;
    const ours = gone.filter((item) => answers[item.requestID] !== undefined);
    const theirs = gone.filter((item) => answers[item.requestID] === undefined);
    if (ours.length > 0) {
      setLeaving((current) => [...current, ...ours]);
      setTimeout(() => setLeaving((current) => current.filter((item) => !ours.includes(item))), LEAVE_MS);
    }
    if (theirs.length > 0) {
      setGhosts((current) => [...current, ...theirs.map((item) => ({ requestID: item.requestID, title: cardTitle(item) }))]);
      setTimeout(() => setGhosts((current) => current.filter((ghost) => !theirs.some((item) => item.requestID === ghost.requestID))), 4_000);
    }
  }, [pending, answers]);

  if (pending.length + ghosts.length + leaving.length === 0) return null;
  // 맨 앞 카드 하나만 펴고 나머지는 뒤에 겹쳐 수만 보인다 — 여럿을 다 펴면 도크가 대화를 다 덮는다. 알림으로 연 카드가 맨 앞이다
  const focused = pending.find((item) => item.requestID === focusCard);
  const [first, ...rest] = focused === undefined ? pending : [focused, ...pending.filter((item) => item !== focused)];
  return (
    <div className="pending-stack">
      {ghosts.map((ghost) => (
        <div key={ghost.requestID} className="handled-card enter" role="status">
          <Icon icon={Check} className="bold" /><span>{ghost.title} · 다른 기기에서 처리했습니다</span>
        </div>
      ))}
      {leaving.map((item) => (
        <PendingCard key={item.requestID} sessionId={sessionId} pending={item} focused={false} sending={false} more={0} leaving />
      ))}
      {first !== undefined ? (
        <div className="lamp-pile" data-depth={Math.min(rest.length, 2)}>
          <PendingCard key={first.requestID} sessionId={sessionId} pending={first} focused={first.requestID === focusCard} sending={answers[first.requestID] === "sending"} more={rest.length} />
          {rest.length > 0 ? <span className="lamp-pile-layer one" aria-hidden="true" /> : null}
          {rest.length > 1 ? <span className="lamp-pile-layer two" aria-hidden="true" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function cardTitle(pending: PendingInteraction): string {
  switch (pending.kind) {
    case "permission": return `${pending.request.displayName ?? pending.request.toolName} 권한 요청`;
    case "question": return "Claude 의 질문";
    case "planApproval": return "계획 승인";
    case "elicitation": return `${pending.serverName} 입력 요청`;
    case "dialog": return pending.title;
  }
}

function cardIcon(pending: PendingInteraction) {
  switch (pending.kind) {
    case "permission": return toolIcon(pending.request.toolName);
    case "question": return MessageCircleQuestion;
    case "planApproval": return Map;
    case "elicitation": return Puzzle;
    case "dialog": return SquareStack;
  }
}

type Respond = (answer: Parameters<typeof connection.respond>[2]) => void;

function PendingCard({ sessionId, pending, focused, sending, more, leaving = false }: {
  sessionId: string; pending: PendingInteraction; focused: boolean; sending: boolean;
  /** 뒤에서 기다리는 카드 수 */
  more: number;
  leaving?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  const respond: Respond = (answer) => connection.respond(sessionId, pending.requestID, answer);
  const agent = pending.kind === "permission" && pending.request.agentID !== undefined;
  return (
    <section
      ref={ref} className={`lamp-card kind-${pending.kind} ${focused ? "focused" : ""} ${leaving ? "leaving" : "enter"}`}
      aria-labelledby={titleId} aria-busy={sending} inert={sending || leaving}
    >
      <header className="lamp-card-head">
        <span className="lamp-tile"><Icon icon={cardIcon(pending)} /></span>
        <div className="lamp-card-heading">
          <h2 id={titleId} className="lamp-card-title">{cardTitle(pending)}</h2>
          {agent ? <p className="lamp-card-sub"><Icon icon={Bot} className="small" />서브에이전트가 묻습니다</p> : null}
        </div>
        {sending ? <span className="spinner lamp-card-busy" role="status" aria-label="답을 보내는 중" /> : null}
        {more > 0 && !sending ? <span className="lamp-more">{more}건 더</span> : null}
      </header>
      {pending.kind === "permission" ? <PermissionCard pending={pending} respond={respond} /> : null}
      {pending.kind === "question" ? <QuestionCard requestID={pending.requestID} questions={pending.questions} respond={respond} /> : null}
      {pending.kind === "planApproval" ? <PlanCard plan={pending.plan} respond={respond} /> : null}
      {pending.kind === "elicitation" ? <ElicitationCard pending={pending} respond={respond} /> : null}
      {pending.kind === "dialog" ? (
        <>
          {pending.detail !== undefined ? <p className="lamp-note">{pending.detail}</p> : null}
          <div className="lamp-actions stacked">
            {pending.choices.map((choice) => (
              <button key={choice.id} type="button" className="btn btn-lamp" onClick={() => respond({ kind: "dialog", choice: choice.id })}>{choice.label}</button>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => respond({ kind: "dialog" })}>취소</button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** 「이유 적고 거절」·「수정 요청」·「직접 답하기」가 여는 글칸 — 보이는 이름과 도움말을 붙인다 */
function ReplyBox({ label, hint, value, onChange, rows = 2, children }: {
  label: string; hint: string; value: string; onChange: (value: string) => void; rows?: number; children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="reply-box">
      <label className="reply-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="field-input" value={value} onChange={(event) => onChange(event.target.value)} rows={rows} autoFocus aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="reply-hint">{hint}</p>
      <div className="lamp-actions">{children}</div>
    </div>
  );
}

function PermissionCard({ pending, respond }: { pending: PermissionPending & { kind: "permission" }; respond: Respond }) {
  const [open, setOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const request = pending.request;
  return (
    <>
      <button type="button" className="lamp-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`lamp-summary-text ${request.toolName === "Bash" || request.toolName === "UserShell" ? "mono" : ""}`}>{pending.summary}</span>
        <Icon icon={ChevronRight} className="disclosure small" />
      </button>
      {open ? <pre className="lamp-raw">{JSON.stringify(request.input, null, 2)}</pre> : null}
      {request.decisionReason !== undefined ? <p className="lamp-note">{request.decisionReason}</p> : null}
      {reasonOpen ? (
        <ReplyBox label="Claude 에게 줄 말" hint="적으면 Claude 가 그 말대로 다른 길을 찾고, 비우면 턴을 멈춥니다." value={reason} onChange={setReason}>
          <button type="button" className="btn btn-ghost" onClick={() => setReasonOpen(false)}>돌아가기</button>
          <button type="button" className="btn btn-primary" onClick={() => respond({ kind: "deny", ...(reason.trim() !== "" ? { reason } : {}) })}>
            {reason.trim() === "" ? "거절하고 멈추기" : "이유를 적어 거절"}
          </button>
        </ReplyBox>
      ) : (
        <div className="lamp-actions permission">
          <div className="action-pair">
            <button type="button" className="btn btn-lamp danger" onClick={() => respond({ kind: "deny" })} aria-label="거절하고 턴 멈추기">거절</button>
            <button type="button" className="btn btn-ghost" onClick={() => setReasonOpen(true)}>이유 적고 거절</button>
          </div>
          <div className="action-pair decide">
            {canAllowForSession(pending) ? <button type="button" className="btn btn-lamp" onClick={() => respond({ kind: "allowSession" })}>이 세션 동안 허용</button> : null}
            <button type="button" className="btn btn-primary" onClick={() => respond({ kind: "allow" })}>허용</button>
          </div>
        </div>
      )}
    </>
  );
}

function QuestionCard({ requestID, questions, respond }: { requestID: string; questions: Question[]; respond: Respond }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [freeOpen, setFreeOpen] = useState(false);
  const [free, setFree] = useState("");
  const [missing, setMissing] = useState(false);
  const errorId = useId();
  const answerFor = (question: Question): string | undefined => {
    const typed = other[question.question]?.trim() ?? "";
    if (typed !== "") return typed;
    const labels = selected[question.question] ?? [];
    return labels.length === 0 ? undefined : labels.join(", ");
  };
  const choose = (question: Question, label: string, checked: boolean) => {
    setMissing(false);
    setOther((current) => ({ ...current, [question.question]: "" }));
    setSelected((current) => {
      const labels = current[question.question] ?? [];
      if (!question.multiSelect) return { ...current, [question.question]: [label] };
      return { ...current, [question.question]: checked ? [...labels.filter((value) => value !== label), label] : labels.filter((value) => value !== label) };
    });
  };
  const submit = () => {
    const unanswered = questions.findIndex((question) => answerFor(question) === undefined);
    if (unanswered >= 0) {
      setMissing(true);
      document.querySelector<HTMLInputElement>(`[data-question="${requestID}-${unanswered}"] input`)?.focus();
      return;
    }
    respond({ kind: "answer", answers: Object.fromEntries(questions.map((question) => [question.question, answerFor(question) ?? ""])) });
  };
  return (
    <>
      {questions.map((question, index) => {
        const chosen = selected[question.question] ?? [];
        const preview = question.options.find((option) => chosen.includes(option.label) && option.preview !== undefined)?.preview;
        const unanswered = missing && answerFor(question) === undefined;
        return (
          <fieldset key={question.question} className="question-set" data-question={`${requestID}-${index}`} aria-describedby={unanswered ? errorId : undefined}>
            <legend className="question-legend">
              {question.header !== undefined ? <span className="question-tag">{question.header}</span> : null}
              <span className="question-text">{question.question}</span>
            </legend>
            {question.multiSelect ? <p className="lamp-note">여러 개를 고를 수 있습니다</p> : null}
            <div className="options">
              {question.options.map((option) => (
                <label key={option.label} className="option">
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"} name={`${requestID}-${index}`} value={option.label}
                    checked={chosen.includes(option.label)} onChange={(event) => choose(question, option.label, event.target.checked)}
                  />
                  <span className="option-mark" aria-hidden="true"><Icon icon={Check} className="bold" /></span>
                  <span className="option-text">
                    <span className="option-label">{option.label}</span>
                    {option.description !== undefined ? <span className="option-detail">{option.description}</span> : null}
                  </span>
                </label>
              ))}
              <label className="option other">
                <span className="option-other-label">직접 입력</span>
                <input
                  type="text" className="option-other-input" value={other[question.question] ?? ""} enterKeyHint="done"
                  onChange={(event) => {
                    const value = event.target.value;
                    setMissing(false);
                    setOther((current) => ({ ...current, [question.question]: value }));
                    if (value !== "") setSelected((current) => ({ ...current, [question.question]: [] }));
                  }}
                />
              </label>
            </div>
            {preview !== undefined ? <div className="lamp-well preview"><Markdown text={preview} /></div> : null}
          </fieldset>
        );
      })}
      {missing ? <p id={errorId} className="lamp-error" role="alert">답하지 않은 질문이 있습니다. 선택지를 고르거나 직접 입력하십시오.</p> : null}
      {freeOpen ? (
        <ReplyBox label="질문 대신 Claude 에게 할 말" hint="질문을 닫고 이 말을 보냅니다. 비우면 턴을 멈춥니다." value={free} onChange={setFree}>
          <button type="button" className="btn btn-ghost" onClick={() => setFreeOpen(false)}>돌아가기</button>
          <button type="button" className="btn btn-primary" onClick={() => respond({ kind: "dismiss", ...(free.trim() !== "" ? { reply: free } : {}) })}>질문 닫고 보내기</button>
        </ReplyBox>
      ) : (
        <div className="lamp-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setFreeOpen(true)}>직접 답하기</button>
          <button type="button" className="btn btn-primary" onClick={submit}>답하기</button>
        </div>
      )}
    </>
  );
}

function PlanCard({ plan, respond }: { plan: string; respond: Respond }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <>
      <div className="lamp-well plan"><Markdown text={plan} /></div>
      {feedbackOpen ? (
        <ReplyBox label="고칠 점" hint="Claude 가 계획을 다시 세웁니다." value={feedback} onChange={setFeedback} rows={3}>
          <button type="button" className="btn btn-ghost" onClick={() => setFeedbackOpen(false)}>돌아가기</button>
          <button type="button" className="btn btn-primary" onClick={() => respond({ kind: "rejectPlan", ...(feedback.trim() !== "" ? { feedback } : {}) })}>수정 요청 보내기</button>
        </ReplyBox>
      ) : (
        <div className="lamp-actions permission">
          <div className="action-pair">
            <button type="button" className="btn btn-ghost" onClick={() => setFeedbackOpen(true)}>수정 요청</button>
          </div>
          <div className="action-pair decide">
            <button type="button" className="btn btn-lamp" onClick={() => respond({ kind: "approvePlan", acceptEdits: true })}>승인하고 편집 자동 수락</button>
            <button type="button" className="btn btn-primary" onClick={() => respond({ kind: "approvePlan" })}>승인</button>
          </div>
        </div>
      )}
    </>
  );
}

function ElicitationCard({ pending, respond }: { pending: Extract<PendingInteraction, { kind: "elicitation" }>; respond: Respond }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(pending.fields.map((field) => [field.name, initialValue(field)])));
  const submit = () => {
    const content: Record<string, string | number | boolean> = {};
    for (const field of pending.fields) {
      const value = values[field.name];
      if (field.type === "boolean") content[field.name] = value === true;
      else if (typeof value === "string" && value.trim() !== "") content[field.name] = field.type === "number" || field.type === "integer" ? Number(value) : value;
    }
    respond({ kind: "elicitation", action: "accept", content });
  };
  return (
    <>
      <p className="lamp-note">{pending.message}</p>
      {pending.url !== undefined ? <a className="btn btn-lamp block" href={pending.url} target="_blank" rel="noopener noreferrer">브라우저에서 열기</a> : null}
      {pending.fields.map((field) => (
        <label key={field.name} className={`lamp-field ${field.type === "boolean" ? "switch-field" : ""}`}>
          <span className="lamp-field-label">{field.title}{field.required ? <span className="required"> · 필수</span> : null}</span>
          {field.type === "boolean" ? (
            <input type="checkbox" role="switch" className="switch" checked={values[field.name] === true} onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })} />
          ) : field.choices !== undefined ? (
            <select className="field-input" value={String(values[field.name] ?? "")} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}>
              {field.required ? null : <option value="">고르지 않음</option>}
              {field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          ) : (
            <input
              className="field-input" type="text" inputMode={field.type === "number" ? "decimal" : field.type === "integer" ? "numeric" : undefined}
              value={String(values[field.name] ?? "")} required={field.required} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          )}
          {field.description !== undefined ? <small className="lamp-field-hint">{field.description}</small> : null}
        </label>
      ))}
      <div className="lamp-actions">
        <button type="button" className="btn btn-ghost" onClick={() => respond({ kind: "elicitation", action: "cancel" })}>취소</button>
        <button type="button" className="btn btn-lamp danger" onClick={() => respond({ kind: "elicitation", action: "decline" })}>거절</button>
        <button type="button" className="btn btn-primary" onClick={pending.mode === "url" ? () => respond({ kind: "elicitation", action: "accept" }) : submit}>
          {pending.mode === "url" ? "마쳤습니다" : "보내기"}
        </button>
      </div>
    </>
  );
}

function initialValue(field: ElicitationField): string | boolean {
  if (field.type === "boolean") return field.defaultValue === true;
  if (field.defaultValue !== undefined) return String(field.defaultValue);
  return field.choices?.[0] !== undefined && field.required ? field.choices[0].value : "";
}
