/**
 * PWA 진입점 — 서비스 워커를 등록하고, 설정을 받고, 이미 허용한 알림은 열 때마다 다시 구독한다
 */
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { App } from "./components/App.tsx";
import { connection } from "./connection.ts";
import { navigate } from "./hooks.ts";
import { refreshPush, registerServiceWorker } from "./push.ts";
import { setState } from "./store.ts";
import "./styles.css";

connection.start();

/**
 * 여러 Mac 을 위한 자리 — 호스트 목록을 이 기기에 둔다. 지금은 자기를 서빙한 호스트 하나만 쓴다
 */
function rememberHost(hostId: string): void {
  try {
    const hosts = JSON.parse(localStorage.getItem("light.hosts") ?? "[]") as { hostId: string; origin: string }[];
    const next = [{ hostId, origin: location.origin }, ...hosts.filter((host) => host.hostId !== hostId)];
    localStorage.setItem("light.hosts", JSON.stringify(next.slice(0, 8)));
  } catch {
    // 저장소를 못 쓰는 창 — 지금 호스트만 쓴다
  }
}

void registerServiceWorker().then(async () => {
  try {
    const config = await api.config();
    rememberHost(config.hostId);
    setState((current) => ({ ...current, config }));
    const pushError = await refreshPush(config.vapidPublicKey);
    if (pushError !== undefined) setState((current) => ({ ...current, pushError }));
  } catch {
    // 연결되면 다시 받는다
  }
});

connection.onMessage((message) => {
  if (message.type === "welcome") {
    api.config().then((config) => setState((current) => ({ ...current, config })), () => undefined);
  }
});

// 알림을 누르면 서비스 워커가 그 세션의 그 카드로 보낸다
navigator.serviceWorker?.addEventListener("message", (event: MessageEvent<{ type?: string; url?: string }>) => {
  if (event.data?.type !== "navigate" || typeof event.data.url !== "string") return;
  const hash = new URL(event.data.url, location.origin).hash;
  if (hash !== "") {
    location.hash = hash;
  } else {
    navigate({ name: "list" });
  }
});

// 시스템 테마가 바뀌면 색 전환이 한꺼번에 돌아 화면이 번진다 — 바뀌는 순간만 전환을 끄고 다음 틀에서 돌려놓는다
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const style = document.createElement("style");
  style.append(document.createTextNode("*,*::before,*::after{transition:none !important}"));
  document.head.append(style);
  void document.body.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
});

createRoot(document.getElementById("root")!).render(<App />);
