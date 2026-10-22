/**
 * 채팅 화면. 긴 대화는 가상 스크롤로 그리고 위로 올리면 앞부분을 나눠 받는다.
 * 머리(제목·경고·할 일·백그라운드 작업)와 도크는 대화 위에 떠 있고 대화는 그 밑으로 흐른다 — 둘의 높이를 재어 목록 앞뒤에 그만큼 비운다.
 * 답을 기다리는 카드는 도크에 노란 등으로 켜지고 입력 카드 위 줄이 진행 상태와 중단을 보인다.
 * 권한 모드·모델·노력도는 입력 카드 안의 칩이고 빠른 모드는 모델 시트의 스위치다. Mac 기록 세션은 읽기 전용으로 보이고 이어받기를 누르면 띄운다 —
 * 터미널에서 살아 있으면 사본으로 이어 가기(기본)와 가져오기 둘이다.
 * 답의 글을 고르면 「인용해 묻기」가 떠 다음 메시지에 인용으로 붙는다. 도는 도구는 도크에서 백그라운드로 넘기고, 백그라운드 작업은 출력을 본다.
 * 세션 메뉴의 되감기는 그 메시지 앞으로 코드·대화를 돌리고 그 글을 입력창에 돌려 둔다
 */
import {
  Activity, Archive, ArchiveRestore, ArrowDown, Check, ChevronDown, Copy, Cpu, Ellipsis, Laptop, Layers, MoveDownRight, Quote, RotateCw, ScrollText, SquarePen,
  SquareTerminal, Square, TriangleAlert, Undo2, Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { EffortLevel, RewindPoint, RewindPreview, RewindScope, SessionView, TaskOutput, ViewItem } from "../../../shared/src/protocol.ts";
import { UPDATE_PLAN_FULL_NAME } from "../../../shared/src/session/turn-box.ts";
import { fastModeBlockedText } from "../../../shared/src/session/view.ts";
import { api, APIError } from "../api.ts";
import { connection } from "../connection.ts";
import { LIFECYCLE_LABELS, effortsFor, findModel, modelChoices, modelLabel, navigate, routeHref, useHeightVar, useModels, useNow } from "../hooks.ts";
import { addQuote, errorText, getState, prependItems, setDraft, setLoadingEarlier, toast, toastError, useAppState } from "../store.ts";
import { Composer, ModeModelChips, effortOptions, permissionModeOptions } from "./Composer.tsx";
import { Icon } from "./icons.tsx";
import { ItemView, type GroupPosition } from "./Items.tsx";
import { NavBar } from "./NavBar.tsx";
import { PendingStack } from "./PendingCards.tsx";
import { ChoiceSheet, ConfirmSheet, Sheet, useSheetClose } from "./Sheet.tsx";

/** 앞부분을 붙일 때 Virtuoso 의 첫 위치 — 충분히 큰 수에서 거꾸로 센다 */
const BASE_INDEX = 1_000_000;

type SheetName = "mode" | "model" | "effort" | "menu" | "rename" | "release" | "takeover" | "takeoverBusy" | "rewind";

/** 도크에서 백그라운드로 넘길 수 있는 도구 — 셸과 서브에이전트 */
const BACKGROUNDABLE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Agent", "Task", "Monitor"]);

export function Chat({ sessionId, card, wide }: { sessionId: string; card?: string; wide: boolean }) {
  const data = useAppState((state) => state.data[sessionId]);
  const summary = useAppState((state) => state.sessions.find((session) => session.id === sessionId));
  const connected = useAppState((state) => state.connection === "connected");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<SheetName | undefined>(undefined);
  const [outputTask, setOutputTask] = useState<SessionView["backgroundTasks"][number] | undefined>(undefined);
  const [selection, setSelection] = useState<string | undefined>(undefined);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    connection.subscribe(sessionId);
    connection.setViewing(sessionId);
    return () => {
      connection.unsubscribe(sessionId);
      connection.setViewing(null);
    };
  }, [sessionId]);

  const view = data?.view;
  const items = data?.items ?? [];
  const models = useModels();
  const currentModel = findModel(models, view?.model);
  const efforts = effortsFor(currentModel, models !== undefined);

  // 서브에이전트 안쪽 항목은 부른 카드 아래에 접어 둔다. 할 일 띠를 고치는 턴 도구 호출은 띠가 보이니 줄로는 그리지 않는다
  const { visible, childCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) if (item.parentToolUseID !== undefined) counts.set(item.parentToolUseID, (counts.get(item.parentToolUseID) ?? 0) + 1);
    return {
      visible: items.filter((item) => (item.parentToolUseID === undefined || expanded.has(item.parentToolUseID)) && item.tool?.name !== UPDATE_PLAN_FULL_NAME),
      childCounts: counts,
    };
  }, [items, expanded]);

  // 답 단추는 마지막 「다음 단계」 상자에만 — 그 뒤에 사람이 말했으면 이미 답한 것이다
  const replyTarget = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "user") return undefined;
      if (item.tool?.wrapUp !== undefined && item.parentToolUseID === undefined) return item.id;
    }
    return undefined;
  }, [items]);
  const reply = useCallback((message: string) => {
    const id = connection.sendMessage(sessionId, message, []);
    if (getState().outbox[id]?.status === "failed") {
      connection.discardOutgoing(id);
      toast("Mac 에 닿지 않아 보내지 못했습니다. 다시 연결되면 한 번 더 누르십시오.", { tone: "error" });
    }
  }, [sessionId]);

  // 도는 포그라운드 도구 — 도크의 「백그라운드로」를 낸다
  const runningTool = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "user") return undefined;
      if (item.parentToolUseID === undefined && item.tool !== undefined && item.tool.state === "running" && BACKGROUNDABLE_TOOLS.has(item.tool.name)
        && item.tool.subagent?.isBackgrounded !== true) return item.tool;
    }
    return undefined;
  }, [items]);

  // 답의 글을 고르면 인용 단추를 띄운다 — 선택이 대화의 Claude 글 안에 있을 때만
  useEffect(() => {
    if (view?.origin !== "light") return;
    const onChange = () => {
      const current = document.getSelection();
      const text = current?.toString().trim() ?? "";
      const anchor = current?.anchorNode instanceof Element ? current.anchorNode : current?.anchorNode?.parentElement;
      const inside = anchor?.closest(".chat-list .item.assistant, .chat-list .item.notice.side, .chat-list .turn-box") !== null && anchor !== undefined && anchor !== null;
      setSelection(text !== "" && inside ? text.slice(0, 20_000) : undefined);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [view?.origin]);
  const quoteSelection = () => {
    if (selection === undefined) return;
    addQuote(sessionId, { label: "Claude 의 답", text: selection });
    document.getSelection()?.removeAllRanges();
    setSelection(undefined);
    document.querySelector<HTMLTextAreaElement>(".dock .composer-input")?.focus();
  };

  // 이어진 도구 줄은 카드 한 장으로 — 앞뒤가 같은 갈래(같은 서브에이전트 안)의 도구인지 본다
  const groups = useMemo(() => {
    const positions = new Map<string, GroupPosition>();
    // 「다음 단계」 상자는 도구 줄이 아니라 따로 선 카드다
    const isTool = (item: ViewItem | undefined, parent: string | undefined) => item?.kind === "tool" && item.tool?.wrapUp === undefined && item.parentToolUseID === parent;
    visible.forEach((item, index) => {
      if (!isTool(item, item.parentToolUseID)) return;
      const before = isTool(visible[index - 1], item.parentToolUseID);
      const after = isTool(visible[index + 1], item.parentToolUseID);
      positions.set(item.id, before && after ? "middle" : before ? "last" : after ? "first" : "solo");
    });
    return positions;
  }, [visible]);

  // 화면을 연 뒤에 새로 온 내 말만 한 번 들어오는 움직임을 준다 — 가상 스크롤이 다시 그려도 되풀이하지 않는다
  // 앞부분 페이지로 붙은 항목은 새로 온 것이 아니다 — 끝의 몇 개만 본다
  const known = useRef<Set<string> | undefined>(undefined);
  const animated = useRef(new Set<string>());
  if (known.current === undefined && data !== undefined) known.current = new Set(items.map((item) => item.id));
  const newest = useMemo(() => new Set(items.slice(-3).map((item) => item.id)), [items]);
  const isFresh = (item: ViewItem) => {
    if (item.kind !== "user" || !newest.has(item.id) || known.current === undefined || known.current.has(item.id) || animated.current.has(item.id)) return false;
    animated.current.add(item.id);
    return true;
  };

  const toggleChildren = useCallback((toolUseID: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(toolUseID)) next.delete(toolUseID);
      else next.add(toolUseID);
      return next;
    });
  }, []);

  const loadEarlier = useCallback(async () => {
    const current = getState().data[sessionId];
    if (current === undefined || current.firstIndex === 0 || current.loadingEarlier || current.epoch === undefined) return;
    setLoadingEarlier(sessionId, true);
    try {
      const page = await api.page(sessionId, current.firstIndex, 120);
      prependItems(sessionId, page.epoch, page.firstIndex, page.items, page.seq);
    } catch (error) {
      setLoadingEarlier(sessionId, false);
      toastError(error, "앞부분을 받지 못했습니다. 위로 다시 올려 보십시오.");
    }
  }, [sessionId]);

  const toBottom = useCallback((behavior: "auto" | "smooth" = "auto") => {
    virtuoso.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior });
  }, []);

  // 도크·목록 칸의 높이가 바뀌어도(카드가 켜지고 키보드가 올라와도) 맨 아래를 보던 대화는 맨 아래에 붙여 둔다
  const keepBottom = useCallback(() => {
    if (atBottomRef.current) requestAnimationFrame(() => toBottom());
  }, [toBottom]);
  const dock = useHeightVar("--dock-h", keepBottom);
  useEffect(() => {
    const element = list.current;
    if (element === null) return;
    const observer = new ResizeObserver(keepBottom);
    observer.observe(element);
    return () => observer.disconnect();
  }, [keepBottom]);

  // Esc 로 진행 중인 턴을 멈춘다
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && view?.isTurnActive === true && sheet === undefined) connection.send({ type: "interrupt", sessionId });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionId, view?.isTurnActive, sheet]);

  const title = view?.title ?? summary?.title ?? "세션";
  const lifecycle = view?.lifecycle ?? summary?.lifecycle;
  const elsewhere = view?.liveElsewhere ?? summary?.liveElsewhere;
  const project = summary?.project ?? view?.cwd.split("/").pop();
  const firstItemIndex = BASE_INDEX - (data?.firstIndex ?? 0);
  // 시트는 나가는 움직임 뒤에 닫힘을 알린다 — 그새 다른 시트로 바뀌었으면 그대로 둔다
  const closeSheet = (name: SheetName) => () => setSheet((current) => (current === name ? undefined : current));
  const stop = () => connection.send({ type: "interrupt", sessionId });

  return (
    <div className="screen chat-screen">
      <NavBar
        heading align="start" edge={!atTop} title={title}
        subtitle={<><LifecycleDot lifecycle={lifecycle} elsewhere={elsewhere} /><span>{[stateLabel(lifecycle, elsewhere, view?.origin ?? summary?.origin), project].filter(Boolean).join(" · ")}</span></>}
        {...(!wide ? { back: { href: routeHref({ name: "list" }), label: "세션 목록" } } : {})}
        trailing={<button type="button" className="icon-btn" onClick={() => setSheet("menu")} aria-label="세션 메뉴"><Icon icon={Ellipsis} /></button>}
      >
        <div className="navbar-extra">
          {view !== undefined ? <NoticeBand view={view} /> : null}
          {view !== undefined && view.tasks.length > 0 ? <TaskBand tasks={view.tasks} /> : null}
          {view !== undefined && view.backgroundTasks.length > 0 ? <BackgroundBand sessionId={sessionId} tasks={view.backgroundTasks} onOutput={setOutputTask} /> : null}
        </div>
      </NavBar>

      <div className="chat-list" ref={list}>
        {data === undefined ? (
          <div className="chat-loading" role="status">
            {connected ? <><span className="spinner" />대화를 불러오는 중…</> : "Mac 에 연결되면 불러옵니다."}
          </div>
        ) : (
          <Virtuoso
            ref={virtuoso}
            className="chat-scroller"
            data={visible}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={Math.max(0, visible.length - 1)}
            alignToBottom
            followOutput={(bottom) => (bottom ? "smooth" : false)}
            atBottomThreshold={48}
            atBottomStateChange={(bottom) => {
              atBottomRef.current = bottom;
              setAtBottom(bottom);
            }}
            atTopStateChange={setAtTop}
            startReached={() => void loadEarlier()}
            increaseViewportBy={{ top: 600, bottom: 300 }}
            computeItemKey={(_, item: ViewItem) => item.id}
            itemContent={(_, item: ViewItem) => (
              <ItemView
                item={item} sessionId={sessionId} childCount={item.tool !== undefined ? childCounts.get(item.tool.toolUseID) ?? 0 : 0}
                expanded={item.tool !== undefined && expanded.has(item.tool.toolUseID)} onToggleChildren={toggleChildren}
                group={groups.get(item.id) ?? "solo"} fresh={isFresh(item)}
                {...(item.id === replyTarget && view?.origin === "light" ? { onReply: reply } : {})}
              />
            )}
            context={{ firstIndex: data.firstIndex, loadingEarlier: data.loadingEarlier }}
            components={LIST_COMPONENTS}
          />
        )}
      </div>

      <button type="button" className="jump-latest" data-shown={!atBottom && data !== undefined} tabIndex={atBottom ? -1 : 0} aria-hidden={atBottom} onClick={() => toBottom("smooth")} aria-label="맨 아래로">
        <Icon icon={ArrowDown} className="bold" />
      </button>

      {view === undefined ? null : (
        <div className="dock chrome" ref={dock}>
          <div className="dock-column">
            {selection !== undefined ? (
              <button type="button" className="chip quote-selection" onPointerDown={(event) => event.preventDefault()} onClick={quoteSelection}>
                <Icon icon={Quote} /><span className="chip-label">인용해 묻기</span>
              </button>
            ) : null}
            <PendingStack sessionId={sessionId} pending={view.pending} {...(card !== undefined ? { focusCard: card } : {})} />
            {view.origin === "history" ? (
              <ResumeCard sessionId={sessionId} view={view} onTakeover={() => setSheet("takeover")} onBusy={() => setSheet("takeoverBusy")} />
            ) : (
              <Composer
                sessionId={sessionId} isTurnActive={view.isTurnActive} queued={view.queued} slashCommands={view.slashCommands}
                {...(view.promptSuggestion !== undefined ? { suggestion: view.promptSuggestion } : {})}
                status={<DockStatus view={view} onStop={stop} {...(runningTool !== undefined ? { onBackground: () => connection.send({ type: "background", sessionId }) } : {})} />}
                toolbar={(
                  <ModeModelChips
                    mode={view.permissionMode ?? "default"} model={modelLabel(view.model)} fast={view.fastMode.requested} verb="바꾸기"
                    onMode={() => setSheet("mode")} onModel={() => setSheet("model")}
                    {...(efforts !== undefined ? { effort: view.effort, onEffort: () => setSheet("effort") } : {})}
                  />
                )}
              />
            )}
          </div>
        </div>
      )}

      {sheet === "mode" && view !== undefined ? (
        <ChoiceSheet
          title="권한 모드" value={view.permissionMode ?? "default"} onClose={closeSheet("mode")}
          options={permissionModeOptions()}
          onChoose={(mode) => connection.send({ type: "setMode", sessionId, mode: mode as "default" })}
        />
      ) : null}
      {sheet === "model" && view !== undefined ? (
        <ChoiceSheet
          title="모델" onClose={closeSheet("model")}
          value={models !== undefined ? (currentModel?.value === "default" ? "" : currentModel?.value)
            : modelChoices(undefined).find((choice) => choice.value !== "" && view.model?.toLowerCase().includes(choice.value))?.value ?? ""}
          options={modelChoices(models).map((choice) => ({ ...choice, icon: Cpu }))}
          note={view.model !== undefined ? `지금: ${view.model}` : undefined}
          onChoose={(model) => connection.send({ type: "setModel", sessionId, model })}
          footer={currentModel?.fastMode === true || view.fastMode.requested ? <FastModeRow sessionId={sessionId} fastMode={view.fastMode} /> : undefined}
        />
      ) : null}
      {sheet === "effort" && view !== undefined && efforts !== undefined ? (
        <ChoiceSheet
          title="노력도" value={view.effort ?? ""} options={effortOptions(efforts)} onClose={closeSheet("effort")}
          note="깊이 생각할수록 답이 느려지고 사용량이 늡니다. 다음 요청부터 적용됩니다."
          onChoose={(effort) => connection.send({ type: "setEffort", sessionId, effort: effort === "" ? null : effort as EffortLevel })}
        />
      ) : null}
      {sheet === "menu" ? (
        <SessionMenu
          sessionId={sessionId} title={title} view={view} onClose={closeSheet("menu")}
          onRename={() => setSheet("rename")} onRelease={() => setSheet("release")} onRewind={() => setSheet("rewind")}
        />
      ) : null}
      {sheet === "rewind" ? <RewindSheet sessionId={sessionId} onClose={closeSheet("rewind")} /> : null}
      {outputTask !== undefined ? <TaskOutputSheet sessionId={sessionId} task={outputTask} onClose={() => setOutputTask(undefined)} /> : null}
      {sheet === "rename" ? <RenameSheet sessionId={sessionId} title={title} onClose={closeSheet("rename")} /> : null}
      {sheet === "release" ? <ReleaseSheet sessionId={sessionId} onClose={closeSheet("release")} /> : null}
      {sheet === "takeover" ? (
        <ConfirmSheet
          title="터미널의 세션을 가져올까요?" confirmLabel="가져오기" tone="danger" onClose={closeSheet("takeover")}
          body={<p>Mac 터미널의 claude 를 끝내고 이 세션을 폰에서 이어 갑니다. 터미널 창은 남지만 그 안의 claude 는 닫힙니다.</p>}
          onConfirm={() => void resume(sessionId, "takeover", false, () => setSheet("takeoverBusy"))}
        />
      ) : null}
      {sheet === "takeoverBusy" ? (
        <ConfirmSheet
          title="도는 턴을 멈추고 가져올까요?" confirmLabel="멈추고 가져오기" tone="danger" onClose={closeSheet("takeoverBusy")}
          body={<p>터미널의 세션이 지금 턴을 도는 중입니다. 가져오면 그 턴은 멈춥니다.</p>}
          onConfirm={() => void resume(sessionId, "takeover", true, () => undefined)}
        />
      ) : null}
    </div>
  );
}

async function resume(sessionId: string, mode: "resume" | "fork" | "takeover", confirmBusy: boolean, onBusy: () => void): Promise<void> {
  try {
    const result = await api.resume(sessionId, mode, confirmBusy);
    if (result.sessionId !== sessionId) navigate({ name: "session", sessionId: result.sessionId }, true);
  } catch (error) {
    if (error instanceof APIError && error.status === 428) onBusy();
    else toastError(error, "이어받지 못했습니다. Mac 이 깨어 있는지 확인하고 다시 누르십시오.");
  }
}

interface ListContext {
  firstIndex: number;
  loadingEarlier: boolean;
}

/** 머리·꼬리는 렌더마다 새 함수로 넘기면 Virtuoso 가 다시 마운트한다 — 고정된 부품으로 두고 값은 `context` 로 넘긴다 */
const LIST_COMPONENTS = {
  Header: ({ context }: { context: ListContext }) => (
    <div className="list-top">
      {context.firstIndex > 0 ? (
        <div className="loading-earlier">{context.loadingEarlier ? <><span className="spinner" />앞부분을 받는 중…</> : "위로 올리면 앞부분을 받습니다"}</div>
      ) : null}
    </div>
  ),
  Footer: () => <div className="list-bottom" />,
};

/** 머리의 상태 글 — 닫힌 세션은 목록 줄처럼 어디에 있는지로 말한다. Mac 터미널에서 도는 기록 세션이 「닫힘」으로 보이지 않게 */
function stateLabel(lifecycle: SessionView["lifecycle"] | undefined, elsewhere: SessionView["liveElsewhere"], origin: SessionView["origin"] | undefined): string | undefined {
  if (lifecycle === undefined) return undefined;
  if (lifecycle !== "closed") return LIFECYCLE_LABELS[lifecycle];
  if (elsewhere !== undefined) return elsewhere.busy ? "Mac 터미널에서 실행 중" : "Mac 터미널에서 열림";
  return origin === "history" ? "Mac 기록" : LIFECYCLE_LABELS.closed;
}

function LifecycleDot({ lifecycle, elsewhere }: { lifecycle: SessionView["lifecycle"] | undefined; elsewhere: SessionView["liveElsewhere"] }) {
  if (lifecycle === "closed" && elsewhere !== undefined) return <span className={`dot ${elsewhere.busy ? "run" : "idle"}`} aria-hidden="true" />;
  if (lifecycle === undefined || lifecycle === "closed") return null;
  const tone = lifecycle === "error" ? "danger" : lifecycle === "waitingPermission" || lifecycle === "waitingQuestion" ? "lamp live"
    : lifecycle === "running" || lifecycle === "starting" ? "run live" : "run";
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

/** 경고 띠 — 재시도·압축·요금제 한도·다른 곳에서 열림·오류. 없으면 그리지 않는다 */
function NoticeBand({ view }: { view: SessionView }) {
  const notes: { key: string; text: string; icon: typeof Layers; busy?: boolean }[] = [];
  if (view.retryNotice !== undefined) notes.push({ key: "retry", text: view.retryNotice, icon: RotateCw, busy: true });
  if (view.isCompacting) notes.push({ key: "compact", text: "대화를 압축하는 중…", icon: Layers, busy: true });
  if (view.rateLimit !== undefined) {
    const used = view.rateLimit.utilization === undefined ? "" : ` ${Math.round(view.rateLimit.utilization * 100)}%`;
    notes.push({ key: "rate", text: view.rateLimit.status === "rejected" ? "요금제 한도에 닿았습니다. 한도가 풀리면 다시 보내십시오." : `요금제 한도에 가깝습니다${used}`, icon: TriangleAlert });
  }
  if (view.liveElsewhere !== undefined && view.origin === "light") notes.push({ key: "elsewhere", text: "Mac 의 다른 곳에서 이 세션이 열려 있습니다", icon: Laptop });
  const failed = view.error !== undefined && view.lifecycle === "error";
  if (notes.length === 0 && !failed) return null;
  return (
    <div className="notice-band" role="status">
      {notes.map((note) => (
        <p key={note.key} className="band-note">
          {note.busy === true ? <span className="spinner" aria-hidden="true" /> : <Icon icon={note.icon} className="small" />}
          <span>{note.text}</span>
        </p>
      ))}
      {failed ? (
        <p className="band-note danger"><Icon icon={TriangleAlert} className="small" /><span>{view.error?.split("\n")[0] ?? "오류"} · 메시지를 보내면 세션을 다시 엽니다</span></p>
      ) : null}
    </div>
  );
}

/** 할 일 — 끝난 수와 지금 하는 일을 고리 하나로 보이고 누르면 펼친다 */
function TaskBand({ tasks }: { tasks: SessionView["tasks"] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.find((task) => task.status === "in_progress");
  const ratio = tasks.length === 0 ? 0 : done / tasks.length;
  return (
    <div className="task-band">
      <button type="button" className="task-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <svg className="task-ring" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8" pathLength="100" />
          <circle cx="10" cy="10" r="8" pathLength="100" className="fill" style={{ strokeDasharray: `${ratio * 100} 100` }} />
        </svg>
        <span className="task-count">할 일 {done}/{tasks.length}</span>
        <span className="task-current">{current !== undefined ? current.activeForm ?? current.subject : done === tasks.length ? "모두 끝났습니다" : ""}</span>
        <Icon icon={ChevronDown} className="disclosure small" />
      </button>
      {open ? (
        <ol className="tasks">
          {tasks.map((task) => (
            <li key={task.id} className={task.status}>
              <span className="task-mark" aria-hidden="true">{task.status === "completed" ? <Icon icon={Check} /> : null}</span>
              <span>{task.subject}</span>
              <span className="sr-only">{task.status === "completed" ? " (끝남)" : task.status === "in_progress" ? " (진행 중)" : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * 백그라운드 작업 — 중단은 턴만 끊으므로 작업은 여기서 하나씩 멈춘다. 수와 첫 작업을 한 줄로 보이고 누르면 펼친다
 */
function BackgroundBand({ sessionId, tasks, onOutput }: { sessionId: string; tasks: SessionView["backgroundTasks"]; onOutput: (task: SessionView["backgroundTasks"][number]) => void }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const first = tasks[0];
  return (
    <div className="task-band">
      <button type="button" className="task-head background-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="spinner" aria-hidden="true" />
        <span className="task-count">백그라운드 {tasks.length}</span>
        <span className="task-current">{first !== undefined ? taskTitle(first) : ""}</span>
        <Icon icon={ChevronDown} className="disclosure small" />
      </button>
      {open ? (
        <ul className="tasks background-tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <Icon icon={Activity} className="small" />
              <span className="background-text">
                <span className="background-title">{taskTitle(task)}</span>
                {task.type !== undefined ? <span className="background-kind">{TASK_KIND_LABELS[task.type] ?? task.type}</span> : null}
              </span>
              <button type="button" className="btn btn-ghost small" aria-label={`${taskTitle(task)} 출력 보기`} onClick={() => onOutput(task)}>
                <Icon icon={ScrollText} />출력
              </button>
              <button
                type="button" className="btn btn-secondary small" aria-disabled={stopping.has(task.id) || undefined}
                aria-label={`${taskTitle(task)} 멈추기`}
                onClick={() => {
                  if (stopping.has(task.id)) return;
                  setStopping(new Set([...stopping, task.id]));
                  connection.send({ type: "stopTask", sessionId, taskId: task.id });
                  // 멈추면 작업 줄이 빠진다 — 그새 안 빠졌으면(실패) 다시 누를 수 있게 푼다
                  setTimeout(() => setStopping((current) => new Set([...current].filter((id) => id !== task.id))), 8_000);
                }}
              >{stopping.has(task.id) ? <span className="spinner" aria-hidden="true" /> : null}멈추기</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const TASK_KIND_LABELS: Record<string, string> = { local_agent: "에이전트", local_bash: "셸", remote_agent: "원격 에이전트", local_workflow: "워크플로", monitor: "감시" };

function taskTitle(task: SessionView["backgroundTasks"][number]): string {
  return task.description !== undefined && task.description !== "" ? task.description : TASK_KIND_LABELS[task.type ?? ""] ?? "작업";
}

/** 모델 시트 아래의 빠른 모드 스위치 — 다음 턴부터 적용된다. 못 켜는 까닭을 claude 가 알렸으면 그 말을 보인다 */
function FastModeRow({ sessionId, fastMode }: { sessionId: string; fastMode: SessionView["fastMode"] }) {
  const blocked = fastModeBlockedText(fastMode.disabledReason);
  const state = fastMode.requested
    ? fastMode.state === "on" ? "켜짐" : fastMode.state === "cooldown" ? "켜짐 · 한도 때문에 잠시 보통 속도" : "다음 턴부터 켜집니다"
    : "꺼짐";
  return (
    <div className="group fast-group">
      <label className="group-row">
        <span className="row-tile"><Icon icon={Zap} /></span>
        <span className="row-text">
          <span className="row-title">빠른 모드</span>
          <span className="row-sub wrap">{blocked !== undefined && fastMode.requested ? blocked : `${state} · 같은 모델이 더 빨리 답하고 사용량이 더 듭니다`}</span>
        </span>
        <input
          type="checkbox" role="switch" className="switch" checked={fastMode.requested}
          onChange={(event) => connection.send({ type: "setFastMode", sessionId, on: event.target.checked })}
        />
      </label>
    </div>
  );
}

/** 컨텍스트 — 창 크기를 알면 몫(%)으로, 모르면 토큰 수로 */
function contextFact(view: SessionView): string | undefined {
  if (view.contextTokens === undefined) return undefined;
  const max = view.contextWindow?.max;
  if (max !== undefined) return `컨텍스트 ${Math.min(100, Math.round((view.contextTokens / max) * 100))}%`;
  return `컨텍스트 ${(view.contextTokens / 1000).toFixed(view.contextTokens >= 100_000 ? 0 : 1)}k`;
}

/** 입력 카드 위 줄 — 일하는 중·컨텍스트·비용과 중단. 할 말이 없으면 그리지 않는다 */
function DockStatus({ view, onStop, onBackground }: { view: SessionView; onStop: () => void; onBackground?: () => void }) {
  const now = useNow(1_000);
  const waiting = view.pending.length > 0;
  const seconds = view.turnStartedAt === undefined ? undefined : Math.max(0, Math.round((now - view.turnStartedAt) / 1000));
  const facts: string[] = [];
  const context = contextFact(view);
  if (context !== undefined) facts.push(context);
  if (view.totalCostUSD !== undefined && view.totalCostUSD > 0) facts.push(`$${view.totalCostUSD.toFixed(2)}`);
  if (!view.isTurnActive && facts.length === 0) return null;
  return (
    <div className="dock-status">
      {view.isTurnActive ? (
        <p className="dock-state" role="status">
          {waiting ? <span className="dot lamp live" aria-hidden="true" /> : <span className="spinner" aria-hidden="true" />}
          <span className={waiting ? "lamp-text" : "shimmer"}>{waiting ? "답을 기다리는 중" : "일하는 중"}</span>
          {seconds !== undefined ? <span className="dock-seconds">{seconds}초</span> : null}
        </p>
      ) : <p className="dock-facts">{facts.join(" · ")}</p>}
      {view.isTurnActive && facts.length > 0 ? <p className="dock-facts">{facts.join(" · ")}</p> : null}
      {view.isTurnActive && onBackground !== undefined && !waiting ? (
        <button type="button" className="chip" onClick={onBackground}><Icon icon={MoveDownRight} /><span className="chip-label">백그라운드로</span></button>
      ) : null}
      {view.isTurnActive ? (
        <button type="button" className="chip stop" onClick={onStop}><Icon icon={Square} /><span className="chip-label">중단</span></button>
      ) : null}
    </div>
  );
}

function ResumeCard({ sessionId, view, onTakeover, onBusy }: { sessionId: string; view: SessionView; onTakeover: () => void; onBusy: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (mode: "resume" | "fork") => {
    setBusy(true);
    await resume(sessionId, mode, false, onBusy);
    setBusy(false);
  };
  const live = view.liveElsewhere;
  return (
    <section className="resume-card" aria-labelledby="resume-title">
      <div className="resume-head">
        <span className="row-tile"><Icon icon={Laptop} /></span>
        <div>
          <h2 id="resume-title" className="resume-title">Mac 기록 세션</h2>
          <p className="resume-text">
            {live !== undefined ? (live.busy ? "Mac 터미널에서 지금 실행 중입니다. 사본으로 이어 가면 터미널은 그대로 둡니다." : "Mac 터미널에서 지금 열려 있습니다. 사본으로 이어 가면 터미널은 그대로 둡니다.") : "읽기 전용입니다. 이어받으면 폰에서 대화를 이어 갑니다."}
          </p>
        </div>
      </div>
      <div className="resume-actions">
        {live !== undefined ? (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onTakeover}>가져오기</button>
            <button type="button" className="btn btn-primary" aria-disabled={busy || undefined} onClick={() => { if (!busy) void run("fork"); }}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}사본으로 이어 가기
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary block" aria-disabled={busy || undefined} onClick={() => { if (!busy) void run("resume"); }}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}{busy ? "띄우는 중…" : "이어받기"}
          </button>
        )}
      </div>
    </section>
  );
}

function SessionMenu({ sessionId, title, view, onClose, onRename, onRelease, onRewind }: {
  sessionId: string; title: string; view: SessionView | undefined; onClose: () => void; onRename: () => void; onRelease: () => void; onRewind: () => void;
}) {
  const light = view?.origin === "light";
  return (
    <Sheet title="세션" onClose={onClose}>
      <div className="menu-summary">
        <p className="menu-title">{title}</p>
        {view !== undefined ? <p className="menu-path"><bdi>{view.cwd}</bdi></p> : null}
      </div>
      <SessionMenuRows sessionId={sessionId} light={light} view={view} onRename={onRename} onRelease={onRelease} onRewind={onRewind} />
      {view?.origin === "history" ? (
        <p className="sheet-note">Mac 기록 세션은 이어받은 뒤에 이름을 바꾸고 보관할 수 있습니다.{view.liveElsewhere !== undefined ? " Mac 에서 열려 있는 세션은 사본으로 이어 가거나 가져올 수 있습니다." : ""}</p>
      ) : null}
    </Sheet>
  );
}

function SessionMenuRows({ sessionId, light, view, onRename, onRelease, onRewind }: {
  sessionId: string; light: boolean; view: SessionView | undefined; onRename: () => void; onRelease: () => void; onRewind: () => void;
}) {
  const close = useSheetClose();
  const archived = useAppState((state) => state.sessions.find((session) => session.id === sessionId)?.archived === true);
  const setArchived = (value: boolean) => api.patchSession(sessionId, { archived: value });
  return (
    <div className="group">
      {light ? (
        <button type="button" className="group-row" onClick={onRename}>
          <span className="row-tile"><Icon icon={SquarePen} /></span><span className="row-text"><span className="row-title">이름 바꾸기</span></span>
        </button>
      ) : null}
      {light ? (
        <button type="button" className="group-row" onClick={() => {
          void setArchived(!archived).then(() => toast(archived ? "보관을 풀었습니다." : "보관했습니다.", {
            action: { label: "되돌리기", run: () => void setArchived(archived).catch((error: unknown) => toastError(error, "되돌리지 못했습니다. 세션 메뉴에서 다시 고르십시오.")) },
          }), (error: unknown) => toastError(error, "보관하지 못했습니다. 연결을 확인하고 다시 고르십시오."));
          close();
        }}>
          <span className="row-tile"><Icon icon={archived ? ArchiveRestore : Archive} /></span>
          <span className="row-text"><span className="row-title">{archived ? "보관 풀기" : "보관"}</span><span className="row-sub">{archived ? "목록에 다시 보입니다" : "목록에서 숨깁니다. 언제든 다시 풉니다"}</span></span>
        </button>
      ) : null}
      {light ? (
        <button type="button" className="group-row" onClick={onRewind}>
          <span className="row-tile"><Icon icon={Undo2} /></span>
          <span className="row-text"><span className="row-title">되감기</span><span className="row-sub">보낸 메시지 앞으로 코드·대화를 돌립니다</span></span>
        </button>
      ) : null}
      {light ? (
        <button type="button" className="group-row" onClick={onRelease}>
          <span className="row-tile"><Icon icon={SquareTerminal} /></span>
          <span className="row-text"><span className="row-title">Mac 터미널에서 이어 가기</span><span className="row-sub">폰 쪽을 닫고 이어 갈 명령을 줍니다</span></span>
        </button>
      ) : null}
      {view !== undefined ? (
        <button type="button" className="group-row" onClick={() => {
          void navigator.clipboard.writeText(view.cwd).then(() => toast("폴더 경로를 복사했습니다."), () => toast("복사하지 못했습니다. 경로를 길게 눌러 고르십시오.", { tone: "error" }));
          close();
        }}>
          <span className="row-tile"><Icon icon={Copy} /></span><span className="row-text"><span className="row-title">폴더 경로 복사</span></span>
        </button>
      ) : null}
    </div>
  );
}

function RenameSheet({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  return (
    <Sheet title="이름 바꾸기" onClose={onClose}>
      <RenameForm sessionId={sessionId} title={title} />
    </Sheet>
  );
}

function RenameForm({ sessionId, title }: { sessionId: string; title: string }) {
  const close = useSheetClose();
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  return (
    <form className="sheet-form" onSubmit={(event) => {
      event.preventDefault();
      // 칸으로 초점을 돌려 낭독기가 칸에 이어 붙은 오류를 읽게 한다
      if (value.trim() === "") {
        setError("이름을 한 글자 이상 적으십시오.");
        input.current?.focus();
        return;
      }
      void api.patchSession(sessionId, { title: value.trim() }).then(close, (cause: unknown) => setError(errorText(cause, "저장하지 못했습니다. 연결을 확인하고 다시 누르십시오.")));
    }}>
      <label className="field-label" htmlFor="rename-input">세션 이름</label>
      <input
        ref={input} id="rename-input" className="field-input" value={value} maxLength={200} data-autofocus="" autoComplete="off" enterKeyHint="done"
        aria-invalid={error !== undefined || undefined} aria-describedby={error !== undefined ? "rename-error" : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError(undefined);
        }}
      />
      {error !== undefined ? <p id="rename-error" className="field-error">{error}</p> : null}
      <div className="sheet-actions inline">
        <button type="button" className="btn btn-secondary" onClick={close}>취소</button>
        <button type="submit" className="btn btn-primary">저장</button>
      </div>
    </form>
  );
}

/** 터미널로 넘기기 — light 쪽 프로세스를 닫고 터미널에서 이어 갈 명령을 준다 */
function ReleaseSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [command, setCommand] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet title="Mac 터미널에서 이어 가기" onClose={onClose}>
      {command === undefined ? (
        <>
          <p className="sheet-prose">폰 쪽 프로세스를 닫고 터미널에서 이어 갈 명령을 줍니다. 진행 중인 턴이 있으면 멈춥니다.</p>
          {error !== undefined ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="sheet-actions inline">
            <button type="button" className="btn btn-primary block" aria-disabled={busy || undefined} onClick={() => {
              if (busy) return;
              setBusy(true);
              void api.release(sessionId).then((result) => setCommand(result.command), (cause: unknown) => setError(`${errorText(cause, "닫지 못했습니다. 연결을 확인하십시오.")} 다시 누르십시오.`)).finally(() => setBusy(false));
            }}>{busy ? <span className="spinner" aria-hidden="true" /> : null}닫고 명령 받기</button>
          </div>
        </>
      ) : (
        <>
          <p className="sheet-prose">Mac 의 터미널에 붙여 넣으십시오.</p>
          <pre className="command">{command}</pre>
          <div className="sheet-actions inline">
            <button type="button" className="btn btn-primary block has-leading-icon" onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true), () => toast("복사하지 못했습니다. 명령을 길게 눌러 고르십시오.", { tone: "error" }))}>
              <Icon icon={Copy} />{copied ? "복사했습니다" : "명령 복사"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** 백그라운드 작업의 출력 — 떠 있는 세션만 안다. 끝 부분부터 보이고 다시 읽기로 갱신한다 */
function TaskOutputSheet({ sessionId, task, onClose }: { sessionId: string; task: SessionView["backgroundTasks"][number]; onClose: () => void }) {
  const [output, setOutput] = useState<TaskOutput | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const load = useCallback(() => {
    setBusy(true);
    void api.taskOutput(sessionId, task.id).then((value) => {
      setOutput(value);
      setError(undefined);
      requestAnimationFrame(() => pre.current?.scrollTo({ top: pre.current.scrollHeight }));
    }, (cause: unknown) => setError(errorText(cause, "출력을 읽지 못했습니다. 연결을 확인하고 다시 읽기를 누르십시오."))).finally(() => setBusy(false));
  }, [sessionId, task.id]);
  useEffect(load, [load]);
  return (
    <Sheet
      title={taskTitle(task)} onClose={onClose}
      actions={<button type="button" className="btn btn-secondary block" aria-disabled={busy || undefined} onClick={() => { if (!busy) load(); }}>{busy ? <span className="spinner" aria-hidden="true" /> : <Icon icon={RotateCw} />}다시 읽기</button>}
    >
      {error !== undefined ? <p className="field-error" role="alert">{error}</p> : null}
      {output === undefined && error === undefined ? <p className="sheet-note"><span className="spinner" aria-hidden="true" /> 읽는 중…</p> : null}
      {output !== undefined ? (
        <>
          <pre ref={pre} className="tool-pre task-output">{output.output === "" ? "(아직 출력이 없습니다)" : output.output}</pre>
          {output.truncated ? <p className="sheet-note">길어서 일부만 보입니다.</p> : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** 되감을 메시지의 시각 — 화면 말과 같은 한국어 형식(Mac 설정 창과 같다) */
const POINT_TIME = new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" });

const REWIND_SCOPE_OPTIONS: { value: RewindScope; label: string; detail: string }[] = [
  { value: "both", label: "대화와 코드", detail: "이 메시지를 보내기 전으로 둘 다 돌립니다" },
  { value: "conversation", label: "대화만", detail: "파일은 지금 그대로 두고 대화만 돌립니다" },
  { value: "code", label: "코드만", detail: "대화는 두고 이 메시지 뒤에 바뀐 파일만 돌립니다" },
];

/**
 * 되감기 — 기록의 사람 메시지를 고르고 무엇을 돌릴지 고른다. 코드는 바뀔 파일을 미리 센다(파일 체크포인트).
 * 끝나면 그 메시지 글을 입력창에 돌려 둔다
 */
function RewindSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [points, setPoints] = useState<RewindPoint[] | undefined>(undefined);
  const [point, setPoint] = useState<RewindPoint | undefined>(undefined);
  const [scope, setScope] = useState<RewindScope>("both");
  const [preview, setPreview] = useState<RewindPreview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const close = useRef<() => void>(onClose);

  useEffect(() => {
    void api.rewindPoints(sessionId).then((value) => setPoints(value.points), (cause: unknown) => setError(errorText(cause, "기록을 읽지 못했습니다. 시트를 닫았다 다시 여십시오.")));
  }, [sessionId]);

  // 메시지를 고르면 코드 쪽 바뀔 파일을 미리 센다
  useEffect(() => {
    if (point === undefined) return;
    setPreview(undefined);
    void api.rewind(sessionId, { pointId: point.id, scope: "code", dryRun: true }).then((value) => setPreview(value.preview), (cause: unknown) => {
      setPreview({ canRewind: false, error: errorText(cause, "미리 세지 못했습니다") });
    });
  }, [sessionId, point]);

  const firstMessage = point !== undefined && point.resumeAt === undefined;
  const run = () => {
    if (point === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    void api.rewind(sessionId, { pointId: point.id, scope }).then((value) => {
      if (value.draft !== undefined && scope !== "code") setDraft(sessionId, value.draft);
      toast(scope === "code" ? "코드를 되감았습니다." : "되감았습니다. 메시지를 고쳐 다시 보내십시오.");
      close.current();
    }, (cause: unknown) => setError(errorText(cause, "되감지 못했습니다. 연결을 확인하고 다시 누르십시오."))).finally(() => setBusy(false));
  };

  return (
    <Sheet title={point === undefined ? "어느 메시지 앞으로 되감을까요?" : "무엇을 되감을까요?"} onClose={onClose}>
      <RewindCloser close={close} />
      {error !== undefined ? <p className="field-error" role="alert">{error}</p> : null}
      {point === undefined ? (
        points === undefined ? (error === undefined ? <p className="sheet-note"><span className="spinner" aria-hidden="true" /> 기록을 읽는 중…</p> : null)
          : points.length === 0 ? <p className="sheet-note">되감을 메시지가 없습니다.</p>
          : (
            <div className="group rewind-points">
              {points.map((candidate) => (
                <button key={candidate.id} type="button" className="group-row" onClick={() => setPoint(candidate)}>
                  <span className="row-text">
                    <span className="row-title clamp-2">{candidate.text}</span>
                    {candidate.timestamp !== undefined ? <span className="row-sub">{POINT_TIME.format(candidate.timestamp)}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          )
      ) : (
        <>
          <blockquote className="rewind-quote">{point.text}</blockquote>
          <div className="group" role="radiogroup" aria-label="되감을 것">
            {REWIND_SCOPE_OPTIONS.map((option) => {
              const disabled = firstMessage && option.value !== "code";
              return (
                <label key={option.value} className={`group-row ${disabled ? "disabled" : ""}`}>
                  <span className="row-text">
                    <span className="row-title">{option.label}</span>
                    <span className="row-sub">{disabled ? "첫 메시지로는 대화를 되감을 수 없습니다. 새 세션을 여십시오" : option.detail}</span>
                  </span>
                  <input type="radio" name="rewind-scope" value={option.value} checked={scope === option.value} disabled={disabled} onChange={() => setScope(option.value)} />
                </label>
              );
            })}
          </div>
          <p className="sheet-note">{rewindPreviewText(preview)}</p>
          <div className="sheet-actions inline">
            <button type="button" className="btn btn-secondary" onClick={() => setPoint(undefined)}>다른 메시지</button>
            <button
              type="button" className="btn btn-danger" aria-disabled={busy || (firstMessage && scope !== "code") || undefined}
              onClick={() => { if (!(firstMessage && scope !== "code")) run(); }}
            >{busy ? <span className="spinner" aria-hidden="true" /> : null}되감기</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** 시트 안에서 닫는 함수를 쥔다 — 되감기가 끝나면 나가는 움직임으로 닫는다 */
function RewindCloser({ close }: { close: { current: () => void } }) {
  close.current = useSheetClose();
  return null;
}

function rewindPreviewText(preview: RewindPreview | undefined): string {
  if (preview === undefined) return "코드 쪽 바뀔 파일을 세는 중…";
  if (!preview.canRewind) return `코드: ${preview.error ?? "되돌릴 체크포인트가 없습니다"}`;
  const files = preview.filesChanged?.length ?? 0;
  if (files === 0) return "코드: 이 메시지 뒤에 바뀐 파일이 없습니다.";
  return `코드: 파일 ${files}개 · +${preview.insertions ?? 0} −${preview.deletions ?? 0}`;
}
