/**
 * light 서비스 워커 — 웹 푸시와 앱 껍데기 캐시.
 * iOS 는 푸시를 받고 알림을 띄우지 않으면 구독을 거둔다 — 받은 푸시는 늘 알림으로 띄운다.
 * 받으면 데몬에 수신을 알린다(도착 비율). 알림을 누르면 그 세션의 그 카드로 연다
 */
const SHELL = "light-shell-v2";
const SHELL_FILES = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** 잘 받은 응답은 껍데기 캐시에 한 벌 둔다 */
function keep(key, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(SHELL).then((cache) => cache.put(key, copy)).catch(() => undefined);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    // 화면은 늘 새로 — Mac 에 닿지 않을 때만 쥔 껍데기를 보인다
    event.respondWith(fetch(request).then((response) => keep("/", response)).catch(async () => (await caches.match("/")) ?? Response.error()));
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => keep(request, response))));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "light", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" ? data.title : "light";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: typeof data.url === "string" ? data.url : "/", sessionId: data.sessionId, requestId: data.requestId },
  };
  const ack = typeof data.id === "string" && typeof data.device === "string"
    ? fetch("/api/push/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pushId: data.id, deviceId: data.device }) }).catch(() => undefined)
    : Promise.resolve();
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), ack]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      client.postMessage({ type: "navigate", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/** 브라우저가 구독을 갈았다 — 새 구독을 데몬에 알린다(Safari 는 부르지 않을 수 있다. PWA 를 열 때도 다시 등록한다) */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const config = await (await fetch("/api/config")).json();
      const key = Uint8Array.from(atob(config.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(config.vapidPublicKey.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
      const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch("/api/push/resubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : null, subscription: subscription.toJSON() }) });
    } catch {
      // PWA 를 열 때 다시 등록한다
    }
  })());
});
