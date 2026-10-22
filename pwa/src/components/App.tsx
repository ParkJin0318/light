/**
 * 틀 — 아이폰은 목록 → 채팅 두 단계, 아이패드 가로는 사이드바 목록 + 채팅 2열이고
 * 세로·Split View·Stage Manager 로 폭이 줄면 1열로 접힌다. 넓은 화면에서 고른 세션이 없으면 오른쪽은 새 세션이다.
 * 연결이 끊기면 위쪽 띠로 알리고 붙어 있을 때는 목록의 큰 제목 아래에 조용히 적는다.
 * 처음 들어오면 홈 화면에 추가하기·알림 켜기를 시트로 안내한다(Welcome)
 */
import { CloudOff } from "lucide-react";
import { useEffect } from "react";
import { navigate, useKeyboardWithoutPan, useMedia, useRoute, useVisualViewportHeight } from "../hooks.ts";
import { useAppState } from "../store.ts";
import { Chat } from "./Chat.tsx";
import { Icon } from "./icons.tsx";
import { NewSession } from "./NewSession.tsx";
import { SessionList } from "./SessionList.tsx";
import { Settings } from "./Settings.tsx";
import { ToastHost } from "./Toast.tsx";
import { Welcome } from "./Welcome.tsx";

export function App() {
  useVisualViewportHeight();
  useKeyboardWithoutPan();
  const route = useRoute();
  const wide = useMedia("(min-width: 900px)");
  const connection = useAppState((state) => state.connection);
  const sessions = useAppState((state) => state.sessions);
  const waiting = sessions.filter((session) => session.lifecycle === "waitingPermission" || session.lifecycle === "waitingQuestion").length;

  // 홈 화면 아이콘 배지 — 답을 기다리는 세션 수
  useEffect(() => {
    const badge = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (waiting > 0) void badge.setAppBadge?.(waiting).catch(() => undefined);
    else void badge.clearAppBadge?.().catch(() => undefined);
  }, [waiting]);

  // 화면 제목 — 지금 보는 곳부터(2.4.2)
  useEffect(() => {
    const prefix = waiting > 0 ? `(${waiting}) ` : "";
    const place = route.name === "session" ? sessions.find((session) => session.id === route.sessionId)?.title
      : route.name === "new" ? "새 세션" : route.name === "settings" ? "설정" : undefined;
    document.title = `${prefix}${place !== undefined ? `${place} · ` : ""}light`;
  }, [route, sessions, waiting]);

  // 하드웨어 키보드 단축키 — 앞뒤 세션, 새 세션
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.code === "KeyN") {
        event.preventDefault();
        navigate({ name: "new" });
        return;
      }
      if (!event.metaKey || (event.key !== "[" && event.key !== "]")) return;
      const ids = sessions.filter((session) => session.archived !== true).map((session) => session.id);
      if (ids.length === 0) return;
      event.preventDefault();
      const current = route.name === "session" ? ids.indexOf(route.sessionId) : -1;
      const next = event.key === "]" ? Math.min(ids.length - 1, current + 1) : Math.max(0, current - 1);
      navigate({ name: "session", sessionId: ids[next]! });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions, route]);

  const main = route.name === "session" ? <Chat key={route.sessionId} sessionId={route.sessionId} {...(route.card !== undefined ? { card: route.card } : {})} wide={wide} />
    : route.name === "new" || (wide && route.name === "list") ? <NewSession key="new" wide={wide} />
    : route.name === "settings" ? <Settings wide={wide} />
    : undefined;

  return (
    <div className={`app ${wide ? "wide" : "narrow"}`}>
      <div className="top-edge" aria-hidden="true" />
      <div className="conn-region" role="status">
        {connection !== "connected" ? (
          <div className={`conn-banner chrome ${connection}`}>
            {connection === "unreachable" ? <Icon icon={CloudOff} /> : <span className="spinner" aria-hidden="true" />}
            <span>
              {connection === "connecting" ? "Mac 에 연결하는 중…" : connection === "reconnecting" ? "다시 연결하는 중…" : "Mac 에 닿지 않습니다. Mac 이 깨어 있고 Tailscale 이 켜져 있는지 확인하십시오."}
            </span>
          </div>
        ) : null}
      </div>
      {wide ? (
        <div className="split">
          <aside className="sidebar" aria-label="세션 목록"><SessionList {...(route.name === "session" ? { selectedId: route.sessionId } : {})} /></aside>
          <main className="detail">{main}</main>
        </div>
      ) : (
        <main className="single">{main ?? <SessionList />}</main>
      )}
      <ToastHost />
      <Welcome />
    </div>
  );
}
