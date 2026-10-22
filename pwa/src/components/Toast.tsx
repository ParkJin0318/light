/**
 * 위쪽에 떠서 내려오는 짧은 알림 — 도크·키보드와 자리를 다투지 않는다.
 * 알림 칸(role=status)은 처음부터 비워 두고 글만 바꿔 넣어야 화면 낭독기가 매번 읽는다.
 * 보통 알림은 3.2초 뒤 사라지고, 누르거나 초점이 가 있으면 기다린다. 오류와 되돌리기가 붙은 알림은 닫을 때까지 남는다
 */
import { CircleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePresence } from "../hooks.ts";
import { dismissToast, useAppState, type Toast as ToastData } from "../store.ts";
import { Icon } from "./icons.tsx";

const SHOW_MS = 3_200;

export function ToastHost() {
  const current = useAppState((state) => state.toast);
  const [shown, setShown] = useState<ToastData | undefined>(current);
  const presence = usePresence(current !== undefined, 150);
  const hovering = useRef(false);

  useEffect(() => {
    if (current !== undefined) setShown(current);
  }, [current]);

  useEffect(() => {
    if (current === undefined || current.tone === "error" || current.action !== undefined) return;
    const at = current.at;
    let timer = setTimeout(function expire() {
      if (hovering.current) timer = setTimeout(expire, 800);
      else dismissToast(at);
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [current]);

  const sticky = shown !== undefined && (shown.tone === "error" || shown.action !== undefined);
  return (
    <div className="toast-region chrome">
      {/* 낭독용 칸 — 늘 그려 두고 글만 바꾼다 */}
      <div className="sr-only" role="status">{current?.tone !== "error" ? current?.text ?? "" : ""}</div>
      <div className="sr-only" role="alert">{current?.tone === "error" ? current.text : ""}</div>
      {presence.mounted && shown !== undefined ? (
        <div
          className={`toast ${shown.tone === "error" ? "error" : ""}`} data-state={presence.state} key={shown.at}
          onPointerEnter={() => { hovering.current = true; }} onPointerLeave={() => { hovering.current = false; }}
          onFocus={() => { hovering.current = true; }} onBlur={() => { hovering.current = false; }}
        >
          {shown.tone === "error" ? <Icon icon={CircleAlert} className="toast-icon" /> : null}
          <span className="toast-text">{shown.text}</span>
          {shown.action !== undefined ? (
            <button type="button" className="toast-action" onClick={() => {
              shown.action?.run();
              dismissToast(shown.at);
            }}>{shown.action.label}</button>
          ) : null}
          {sticky ? (
            <button type="button" className="icon-btn toast-close" onClick={() => dismissToast(shown.at)} aria-label="알림 닫기"><Icon icon={X} /></button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
