/**
 * 세션 목록 — 답을 기다리는 세션을 맨 위 노란 카드로 올리고, 지금 살아 있는 세션을 그 아래에, 나머지는 프로젝트별 묶음 카드로 둔다.
 * light 세션·Mac 기록·Mac 터미널에서 열린 세션을 줄마다 글로 가른다. 실시간으로 바뀌고 당기면 새로 받는다.
 * 검색과 새 세션은 엄지가 닿는 아래 떠 있는 막대에 둔다. 큰 제목이 머리 밑으로 들어가면 머리에 작은 제목이 켜진다
 */
import { Archive, ArrowDown, BellRing, ChevronDown, ChevronRight, Folder, MessagesSquare, Plus, Search, Settings as SettingsIcon, X } from "lucide-react";
import { useMemo, useRef, useState, type TouchEvent } from "react";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { api } from "../api.ts";
import { LIFECYCLE_LABELS, relativeTime, routeHref, useHeightVar, useNow, useScrolledPast } from "../hooks.ts";
import { setState, toastError, useAppState, type ConnectionState } from "../store.ts";
import { Icon } from "./icons.tsx";
import { NavBar } from "./NavBar.tsx";

/** 한 묶음에 처음 보이는 줄 수 — 나머지는 「N개 더 보기」로 연다 */
const GROUP_PREVIEW = 4;

/** 앱을 연 뒤 처음 그릴 때만 묶음이 차례로 들어온다 — 목록으로 돌아올 때마다 되풀이하지 않는다 */
let entered = false;

function isWaiting(session: SessionSummary): boolean {
  return session.lifecycle === "waitingPermission" || session.lifecycle === "waitingQuestion";
}

/** light 프로세스가 살아 있거나 Mac 터미널에서 열려 있는 세션 */
function isOpen(session: SessionSummary): boolean {
  return session.lifecycle !== "closed" || session.liveElsewhere !== undefined;
}

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: "Mac 에 붙는 중", connected: "Mac 에 연결됨", reconnecting: "다시 붙는 중", unreachable: "Mac 에 닿지 않음",
};

export function SessionList({ selectedId }: { selectedId?: string }) {
  const sessions = useAppState((state) => state.sessions);
  const loaded = useAppState((state) => state.sessionsLoaded);
  const connection = useAppState((state) => state.connection);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const now = useNow();
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const collapsed = useScrolledPast(scroll, 44);
  const bar = useHeightVar("--bar-h");
  const [animate] = useState(() => !entered);
  entered = true;

  const { waiting, open, groups, archivedCount, liveCount } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (session: SessionSummary) => needle === ""
      || session.title.toLowerCase().includes(needle) || session.project.toLowerCase().includes(needle)
      || (session.lastMessage ?? "").toLowerCase().includes(needle);
    const visible = sessions.filter((session) => matches(session) && (showArchived || session.archived !== true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const byProject = new Map<string, SessionSummary[]>();
    for (const session of visible) {
      if (isOpen(session)) continue;
      const list = byProject.get(session.cwd) ?? [];
      list.push(session);
      byProject.set(session.cwd, list);
    }
    const grouped = [...byProject.entries()]
      .map(([cwd, list]) => ({ cwd, project: list[0]!.project, sessions: list }))
      .sort((a, b) => b.sessions[0]!.updatedAt - a.sessions[0]!.updatedAt);
    return {
      waiting: visible.filter(isWaiting),
      open: visible.filter((session) => isOpen(session) && !isWaiting(session)),
      groups: grouped,
      archivedCount: sessions.filter((session) => session.archived === true).length,
      liveCount: sessions.filter((session) => isOpen(session)).length,
    };
  }, [sessions, query, showArchived]);

  const pull = usePullToRefresh(async () => {
    const result = await api.sessions();
    setState((current) => ({ ...current, sessions: result.sessions, sessionsLoaded: true }));
  });

  // 묶음 단위로 100ms 씩 늦춰 들어온다 — 처음 몇 묶음만
  let chunk = 0;
  const enter = (base: string) => (animate ? { className: `${base} enter`, style: { animationDelay: `${Math.min(chunk++, 4) * 100}ms` } } : { className: base });
  const searching = query.trim() !== "";
  const nothingFound = loaded && sessions.length > 0 && searching && waiting.length + open.length + groups.length === 0;

  return (
    <div className="screen list-screen">
      <NavBar
        title="light" collapsed={collapsed} edge={collapsed}
        trailing={<a className="icon-btn" href={routeHref({ name: "settings" })} aria-label="설정"><Icon icon={SettingsIcon} /></a>}
      />
      <div className="list-scroll" ref={scroll} {...pull.handlers}>
        <div className="pull" style={{ height: pull.distance }} aria-hidden="true">
          {pull.refreshing ? <span className="spinner" /> : <Icon icon={ArrowDown} className={pull.distance > 60 ? "armed" : ""} />}
        </div>
        <div className="list-column">
          <div {...enter("hero")}>
            <h1 className="wordmark"><span className={`lamp-mark ${waiting.length > 0 ? "lit" : ""}`} aria-hidden="true" />light</h1>
            <p className="hero-sub">
              <span className={`dot ${connection === "connected" ? "run" : connection === "unreachable" ? "danger" : "lamp live"}`} aria-hidden="true" />
              <span>{CONNECTION_TEXT[connection]}</span>
              {loaded && liveCount > 0 ? <span className="hero-count">· 열린 세션 {liveCount}개</span> : null}
            </p>
          </div>

          {!loaded ? <ListSkeleton /> : null}
          {loaded && sessions.length === 0 ? (
            <div className="empty-card">
              <span className="empty-tile" aria-hidden="true"><Icon icon={MessagesSquare} /></span>
              <p className="empty-title">아직 세션이 없습니다</p>
              <p className="empty-text">새 세션을 시작하거나 Mac 에서 Claude Code 를 쓰면 여기에 보입니다.</p>
              <a className="btn btn-primary has-leading-icon" href={routeHref({ name: "new" })}><Icon icon={Plus} />새 세션 시작</a>
            </div>
          ) : null}
          {nothingFound ? (
            <div className="empty-card">
              <Icon icon={Search} className="empty-icon" />
              <p className="empty-title">「{query.trim()}」와 맞는 세션이 없습니다</p>
              <p className="empty-text">제목·프로젝트·마지막 메시지에서 찾습니다.</p>
              <button type="button" className="btn btn-secondary" onClick={() => setQuery("")}>검색 지우기</button>
            </div>
          ) : null}

          {waiting.length > 0 ? (
            <section {...enter("section")} aria-labelledby="waiting-head">
              <h2 id="waiting-head" className="section-head lamp">답을 기다림<span className="count">{waiting.length}</span></h2>
              <div className="lamp-stack">
                {waiting.map((session) => <WaitingCard key={session.id} session={session} now={now} selected={session.id === selectedId} />)}
              </div>
            </section>
          ) : null}

          {open.length > 0 ? (
            <section {...enter("section")} aria-labelledby="open-head">
              <h2 id="open-head" className="section-head">열려 있음<span className="count">{open.length}</span></h2>
              <div className="group">
                {open.map((session) => <SessionRow key={session.id} session={session} now={now} selected={session.id === selectedId} showProject />)}
              </div>
            </section>
          ) : null}

          {groups.map((group) => {
            const all = searching || expanded.has(group.cwd);
            const shown = all ? group.sessions : group.sessions.slice(0, GROUP_PREVIEW);
            const hidden = group.sessions.length - shown.length;
            const headId = `project-${group.cwd}`;
            return (
              <section key={group.cwd} {...enter("section")} aria-labelledby={headId}>
                <h2 id={headId} className="section-head">
                  <Icon icon={Folder} className="small" />
                  <span className="section-name">{group.project}</span>
                  <span className="count">{group.sessions.length}</span>
                </h2>
                <div className="group">
                  {shown.map((session) => <SessionRow key={session.id} session={session} now={now} selected={session.id === selectedId} />)}
                  {hidden > 0 ? (
                    <button type="button" className="group-row more-row" onClick={() => setExpanded((current) => new Set(current).add(group.cwd))}>
                      <span className="row-lead" />
                      <span className="row-text"><span className="row-title">{hidden}개 더 보기</span></span>
                      <span className="row-trail"><Icon icon={ChevronDown} /></span>
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}

          {archivedCount > 0 ? (
            <div className="list-foot">
              <button type="button" className="btn btn-ghost small has-leading-icon" onClick={() => setShowArchived(!showArchived)} aria-pressed={showArchived}>
                <Icon icon={Archive} />{showArchived ? "보관한 세션 숨기기" : `보관한 세션 ${archivedCount}개 보기`}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="floating-bar chrome" ref={bar}>
        <div className="floating-inner">
          <div className="search">
            <Icon icon={Search} />
            <input
              ref={search} type="search" placeholder="세션 검색" value={query} enterKeyHint="search" aria-label="세션 검색"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query !== "") {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
            {query !== "" ? (
              <button type="button" className="icon-btn" aria-label="검색 지우기" onClick={() => {
                setQuery("");
                search.current?.focus();
              }}><Icon icon={X} /></button>
            ) : null}
          </div>
          <a className="fab" href={routeHref({ name: "new" })} aria-label="새 세션"><Icon icon={Plus} /></a>
        </div>
      </div>
    </div>
  );
}

/** 줄 아래 글 — 상태(닫힌 세션은 빼고)·어디서 온 세션인지·마지막 메시지 */
function metaParts(session: SessionSummary, showProject: boolean): { state?: string; rest: string[] } {
  const rest: string[] = [];
  if (showProject) rest.push(session.project);
  if (session.liveElsewhere !== undefined) rest.push(session.liveElsewhere.busy ? "Mac 터미널에서 실행 중" : "Mac 터미널에서 열림");
  else rest.push(session.origin === "history" ? "Mac 기록" : "light 세션");
  if (session.lastMessage !== undefined && session.lastMessage !== "") rest.push(session.lastMessage);
  if (session.lifecycle === "closed") return { rest };
  const count = session.pendingCount > 1 ? ` ${session.pendingCount}건` : "";
  return { state: `${LIFECYCLE_LABELS[session.lifecycle]}${count}`, rest };
}

/** 상태 점 — 일하는 중은 채운 점, 쉬는 중은 고리다. 닫힌 Mac 기록은 점 없이 자리만 둬 제목이 같은 선에 선다 */
function StatusDot({ session }: { session: SessionSummary }) {
  const tone = session.lifecycle === "error" ? "danger"
    : isWaiting(session) ? "lamp"
    : session.lifecycle === "running" || session.lifecycle === "starting" ? "run"
    : session.lifecycle === "idle" ? "idle"
    : session.liveElsewhere !== undefined ? (session.liveElsewhere.busy ? "run" : "idle")
    : undefined;
  return tone === undefined ? null : <span className={`dot ${tone}`} aria-hidden="true" />;
}

function SessionRow({ session, now, selected, showProject = false }: { session: SessionSummary; now: number; selected: boolean; showProject?: boolean }) {
  const meta = metaParts(session, showProject);
  const tone = session.lifecycle === "error" ? "danger" : session.lifecycle === "running" || session.lifecycle === "starting" ? "run" : "";
  return (
    <a
      href={routeHref({ name: "session", sessionId: session.id })} className={`group-row session-row ${selected ? "selected" : ""}`}
      aria-current={selected ? "page" : undefined}
    >
      <span className="row-lead"><StatusDot session={session} /></span>
      <span className="row-text">
        <span className="row-line">
          <span className="row-title">{session.title}</span>
          <span className="row-time">{relativeTime(session.updatedAt, now)}</span>
        </span>
        <span className="row-sub">
          {meta.state !== undefined ? <><span className={`row-state ${tone}`}>{meta.state}</span> · </> : null}
          {meta.rest.join(" · ")}
        </span>
      </span>
    </a>
  );
}

function WaitingCard({ session, now, selected }: { session: SessionSummary; now: number; selected: boolean }) {
  const count = session.pendingCount > 1 ? ` ${session.pendingCount}건` : "";
  return (
    <a
      href={routeHref({ name: "session", sessionId: session.id })} className={`lamp-row ${selected ? "selected" : ""}`}
      aria-current={selected ? "page" : undefined}
    >
      <span className="lamp-tile"><Icon icon={BellRing} /></span>
      <span className="row-text">
        <span className="row-line">
          <span className="row-title">{session.title}</span>
          <span className="row-time">{relativeTime(session.updatedAt, now)}</span>
        </span>
        <span className="row-sub"><span className="row-state lamp">{LIFECYCLE_LABELS[session.lifecycle]}{count}</span> · {session.project}</span>
        {session.lastMessage !== undefined && session.lastMessage !== "" ? <span className="row-sub quote">{session.lastMessage}</span> : null}
      </span>
      <Icon icon={ChevronRight} className="row-chevron" />
    </a>
  );
}

/** 처음 받는 동안의 자리 — 줄 모양만 그리고 글은 낭독기에만 */
function ListSkeleton() {
  return (
    <div className="section" role="status">
      <span className="sr-only">Mac 에서 세션을 받는 중…</span>
      <div className="skeleton-head" aria-hidden="true" />
      <div className="group" aria-hidden="true">
        {[0.72, 0.56, 0.64].map((width) => (
          <div key={width} className="group-row skeleton-row">
            <span className="row-lead" />
            <span className="row-text">
              <span className="skeleton-line" style={{ width: `${width * 100}%` }} />
              <span className="skeleton-line short" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 맨 위에서 아래로 당기면 새로 받는다 */
function usePullToRefresh(refresh: () => Promise<void>) {
  const start = useRef<number | undefined>(undefined);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const handlers = {
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      start.current = event.currentTarget.scrollTop <= 0 ? event.touches[0]?.clientY : undefined;
    },
    onTouchMove(event: TouchEvent<HTMLDivElement>) {
      if (start.current === undefined || refreshing) return;
      const delta = (event.touches[0]?.clientY ?? 0) - start.current;
      setDistance(delta > 0 ? Math.min(90, delta * 0.5) : 0);
    },
    onTouchEnd() {
      const pulled = distance > 60;
      start.current = undefined;
      if (!pulled) {
        setDistance(0);
        return;
      }
      setRefreshing(true);
      setDistance(48);
      refresh().catch((error: unknown) => toastError(error, "새로 받지 못했습니다. 연결을 확인하고 다시 당기십시오.")).finally(() => {
        setRefreshing(false);
        setDistance(0);
      });
    },
  };
  return { handlers, distance, refreshing };
}
