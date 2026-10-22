/**
 * 대화 항목 하나. 내 말은 오른쪽 말풍선, Claude 의 글은 단 너비 본문이다.
 * 이어진 도구 호출은 묶음 카드 한 장의 줄들로 보이고(`group`), 줄을 누르면 입력·출력 원문을 고정폭으로 펼친다.
 * 생각 요약은 접힌 채로 두고, 서브에이전트 안쪽 항목은 부른 카드 아래에 접어 둔다.
 * 턴 도구 `wrap_up` 은 도구 줄 대신 「다음 단계」 상자로 — 마지막 상자의 답 단추는 누르면 그 글을 보낸다.
 * `!` 셸 줄의 출력은 고정폭, 곁가지 질문(`/btw`)은 질문과 답을 한 장에 그린다
 */
import { Ban, Brain, Check, ChevronRight, CircleAlert, Clock, FileText, Info, Layers, MessageCircleQuestion, Power, Quote, X } from "lucide-react";
import { memo, useState } from "react";
import type { ViewItem, ViewTool } from "../../../shared/src/protocol.ts";
import type { TurnWrapUp } from "../../../shared/src/session/turn-box.ts";
import { imageURL } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { Icon, isCodeLine, toolIcon } from "./icons.tsx";

/** 이어진 도구 줄에서 이 줄의 자리 — 카드 모서리와 구분선을 정한다 */
export type GroupPosition = "solo" | "first" | "middle" | "last";

export const ItemView = memo(function ItemView({ item, sessionId, childCount, expanded, onToggleChildren, group, fresh, onReply }: {
  item: ViewItem; sessionId: string; childCount: number; expanded: boolean; onToggleChildren: (toolUseID: string) => void;
  group: GroupPosition;
  /** 화면을 연 뒤 새로 들어온 항목 — 한 번만 들어오는 움직임을 준다 */
  fresh: boolean;
  /** 「다음 단계」 상자의 답 단추 — 마지막 상자에만 준다 */
  onReply?: (message: string) => void;
}) {
  const nested = item.parentToolUseID !== undefined ? "nested" : "";
  const enter = fresh ? "enter" : "";
  switch (item.kind) {
    case "user":
      return (
        <div className={`item user ${nested} ${enter}`}>
          <div className="bubble">
            {item.images !== undefined && item.images.length > 0 ? (
              <div className={`bubble-images count-${Math.min(item.images.length, 3)}`}>
                {item.images.map((image) => (
                  <a key={image.id} href={imageURL(sessionId, image.id)} target="_blank" rel="noreferrer" aria-label="첨부한 이미지 크게 보기">
                    <img src={imageURL(sessionId, image.id)} alt="첨부한 이미지" loading="lazy" />
                  </a>
                ))}
              </div>
            ) : null}
            {item.files !== undefined && item.files.length > 0 ? (
              <div className="bubble-files">
                {item.files.map((file) => (
                  <span key={file} className="file-chip"><Icon icon={FileText} /><span className="file-chip-name">{file.split("/").pop()}</span></span>
                ))}
              </div>
            ) : null}
            {item.snippets !== undefined && item.snippets.length > 0 ? (
              <div className="bubble-quotes">
                {item.snippets.map((snippet, index) => (
                  <blockquote key={index} className="bubble-quote"><Icon icon={Quote} className="small" /><span>{snippet.text}</span></blockquote>
                ))}
              </div>
            ) : null}
            {item.text !== undefined && item.text !== "" ? <div className="bubble-text">{item.text}</div> : null}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className={`item assistant ${nested} ${item.isStreaming === true ? "streaming" : ""}`}>
          <Markdown text={item.text ?? ""} />
        </div>
      );
    case "thinking":
      return <Thinking item={item} nested={nested} />;
    case "tool":
      if (item.tool?.wrapUp !== undefined) return <TurnBox wrapUp={item.tool.wrapUp} nested={nested} {...(onReply !== undefined ? { onReply } : {})} />;
      return item.tool === undefined ? null : (
        <ToolRow
          tool={item.tool} sessionId={sessionId} nested={nested} group={group} childCount={childCount} expanded={expanded} onToggleChildren={onToggleChildren}
          seconds={item.startedAt !== undefined && item.finishedAt !== undefined ? (item.finishedAt - item.startedAt) / 1000 : undefined}
        />
      );
    case "notice":
      return item.notice === undefined ? null : <NoticeLine kind={item.notice.kind} text={item.notice.text} nested={nested} />;
  }
});

/** 턴 끝의 「다음 단계」 상자 — 요약, 질문, 답 단추(첫 단추가 Claude 의 권하는 쪽) */
function TurnBox({ wrapUp, nested, onReply }: { wrapUp: TurnWrapUp; nested: string; onReply?: (message: string) => void }) {
  const [sent, setSent] = useState<string | undefined>(undefined);
  return (
    <div className={`item turn-box ${nested}`}>
      <section className={`turn-card ${wrapUp.blocked === true ? "blocked" : ""}`} aria-label="다음 단계">
        <p className="turn-recap">{wrapUp.recap}</p>
        {wrapUp.ask !== undefined ? <p className="turn-ask">{wrapUp.ask}</p> : null}
        {wrapUp.actions.length > 0 && onReply !== undefined ? (
          <div className="turn-actions">
            {wrapUp.actions.map((action, index) => (
              <button
                key={action.label} type="button" className={`btn small ${index === 0 ? "btn-primary" : "btn-secondary"}`}
                aria-disabled={sent !== undefined || undefined}
                onClick={() => {
                  if (sent !== undefined) return;
                  setSent(action.label);
                  onReply(action.message);
                }}
              >{sent === action.label ? <Icon icon={Check} className="bold" /> : null}{action.label}</button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Thinking({ item, nested }: { item: ViewItem; nested: string }) {
  const [open, setOpen] = useState(false);
  const text = item.text ?? "";
  const streaming = item.isStreaming === true;
  if (text.trim() === "" && !streaming) return null;
  return (
    <div className={`item thinking ${nested}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon icon={Brain} />
        <span className={streaming ? "shimmer" : ""}>{streaming ? "생각하는 중…" : "생각"}</span>
        <Icon icon={ChevronRight} className="disclosure small" />
      </button>
      {open ? <div className="thinking-body">{text}</div> : null}
    </div>
  );
}

const STATE_LABELS: Record<ViewTool["state"], string> = {
  composing: "준비 중", running: "실행 중", awaitingDecision: "승인 대기", succeeded: "완료", failed: "실패",
};

function durationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 1) return undefined;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초` : `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}초`;
}

function ToolState({ state }: { state: ViewTool["state"] }) {
  switch (state) {
    case "composing":
    case "running": return <span className="spinner" aria-hidden="true" />;
    case "awaitingDecision": return <span className="dot lamp live" aria-hidden="true" />;
    case "succeeded": return <Icon icon={Check} className="tool-ok bold" />;
    case "failed": return <Icon icon={X} className="tool-failed bold" />;
  }
}

function ToolRow({ tool, sessionId, nested, group, childCount, expanded, onToggleChildren, seconds }: {
  tool: ViewTool; sessionId: string; nested: string; group: GroupPosition; childCount: number; expanded: boolean;
  onToggleChildren: (toolUseID: string) => void; seconds: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const subagent = tool.subagent;
  const activity = subagent?.status === undefined || subagent.status === "running" ? subagent?.activity : undefined;
  const summary = subagent?.status !== undefined && subagent.status !== "running" ? subagent.summary : undefined;
  const duration = tool.state === "succeeded" || tool.state === "failed" ? durationLabel(seconds) : undefined;
  return (
    <div className={`item tool ${nested} at-${group}`}>
      <div className={`tool-slice ${tool.state}`}>
        <button
          type="button" className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}
          aria-label={`${tool.title} ${tool.line} ${STATE_LABELS[tool.state]}`}
        >
          <span className="tool-glyph"><Icon icon={toolIcon(tool.name)} /></span>
          <span className="tool-text">
            <span className="tool-title">{tool.title}</span>
            {tool.line !== "" ? <span className={`tool-line ${isCodeLine(tool.name) ? "code" : ""}`}>{tool.line}</span> : null}
          </span>
          {duration !== undefined ? <span className="tool-time">{duration}</span> : null}
          <span className="tool-state"><ToolState state={tool.state} /></span>
        </button>
        {activity !== undefined ? <p className="tool-note"><span className="shimmer">{activity}</span></p> : null}
        {summary !== undefined ? <p className="tool-note">{summary}</p> : null}
        {childCount > 0 ? (
          <button type="button" className="tool-children" onClick={() => onToggleChildren(tool.toolUseID)} aria-expanded={expanded}>
            <Icon icon={ChevronRight} className="disclosure small" />
            {expanded ? "서브에이전트 기록 접기" : `서브에이전트 기록 ${childCount}개 펼치기`}
          </button>
        ) : null}
        {open ? (
          <div className="tool-body">
            <div className="tool-label">입력</div>
            <pre className="tool-pre">{tool.input}</pre>
            {tool.result !== undefined ? (
              <>
                <div className="tool-label">{tool.state === "failed" ? "출력 · 실패" : "출력"}</div>
                <pre className={`tool-pre ${tool.state === "failed" ? "failed" : ""}`}>{tool.result === "" ? "(빈 출력)" : tool.result}</pre>
              </>
            ) : null}
            {tool.resultImages !== undefined ? (
              <div className="tool-images">
                {tool.resultImages.map((image) => <img key={image.id} src={imageURL(sessionId, image.id)} alt="도구 결과 이미지" loading="lazy" />)}
              </div>
            ) : null}
            {tool.truncated === true ? <p className="tool-label">길어서 앞부분만 보입니다.</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NoticeLine({ kind, text, nested }: { kind: NonNullable<ViewItem["notice"]>["kind"]; text: string; nested: string }) {
  if (kind === "shell") {
    return (
      <div className={`item notice shell ${nested}`}>
        <pre className="tool-pre shell-output">{text}</pre>
      </div>
    );
  }
  if (kind === "side") {
    const split = text.indexOf("\n\n");
    const question = split === -1 ? text : text.slice(0, split);
    const answer = split === -1 ? "" : text.slice(split + 2);
    return (
      <div className={`item notice side ${nested}`}>
        <section className="side-card" aria-label="곁가지 질문">
          <p className="side-question"><Icon icon={MessageCircleQuestion} className="small" /><span>{question}</span></p>
          <Markdown text={answer} />
          <p className="side-note">대화에는 남지 않습니다</p>
        </section>
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className={`item notice error ${nested}`} role="alert">
        <div className="callout danger"><Icon icon={CircleAlert} /><span className="callout-text">{text}</span></div>
      </div>
    );
  }
  const glyph = kind === "turnStats" ? Clock : kind === "interrupted" || kind === "denied" ? Ban : kind === "compacted" ? Layers : kind === "ended" ? Power : Info;
  return (
    <div className={`item notice ${kind} ${nested}`}>
      <span className="notice-line"><Icon icon={glyph} className="small" /><span>{text}</span></span>
    </div>
  );
}
