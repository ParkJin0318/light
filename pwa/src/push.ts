/**
 * 웹 푸시 구독. iOS 는 홈 화면에 추가한 PWA 에서만, 사용자 동작 뒤에만 권한을 물을 수 있다.
 * 구독이 소리 없이 사라진다는 보고가 있어 PWA 를 열 때마다 구독을 다시 등록한다
 */
import { api } from "./api.ts";

export type PushSupport = "unsupported" | "needsInstall" | "default" | "granted" | "denied";

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (!("serviceWorker" in navigator)) return "unsupported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  if (!("PushManager" in window) || !("Notification" in window)) return ios && !isStandalone() ? "needsInstall" : "unsupported";
  if (ios && !isStandalone()) return "needsInstall";
  return Notification.permission === "default" ? "default" : Notification.permission;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac 브라우저";
  return "브라우저";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return undefined;
  }
}

/** 권한을 묻고 구독한다 — 사람이 누른 버튼에서만 부른다 */
export async function enablePush(vapidPublicKey: string): Promise<PushSupport> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";
  await subscribe(vapidPublicKey);
  return "granted";
}

/** 이미 허용했으면 열 때마다 다시 등록한다 — 키가 바뀌었으면 새로 구독한다. 실패하면 그 까닭을 돌려준다(설정 화면이 보인다) */
export async function refreshPush(vapidPublicKey: string): Promise<string | undefined> {
  if (pushSupport() !== "granted") return undefined;
  try {
    await subscribe(vapidPublicKey);
    return undefined;
  } catch (error) {
    return describeError(error);
  }
}

/** 구독 실패의 까닭 — 오류 이름(NotAllowedError 등)이 원인을 가르므로 함께 적는다. 화면이 문장 안에 넣으므로 끝의 마침표는 뗀다 */
export function describeError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/[.。]\s*$/, "");
}

/**
 * 푸시 서비스가 답하지 않으면 구독이 끝나지 않고 매달린다(iOS 27 시뮬레이터: webpushd 가 실행 제약으로 뜨지 못한다, 2026-10-22 실측).
 * 시한을 두어 까닭을 화면에 보인다
 */
const SUBSCRIBE_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 단계가 ${SUBSCRIBE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다. 이 기기의 푸시 서비스가 응답하지 않습니다.`)), SUBSCRIBE_TIMEOUT_MS);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function subscribe(vapidPublicKey: string): Promise<void> {
  const registration = await withTimeout(navigator.serviceWorker.ready, "서비스 워커 준비");
  const key = keyBytes(vapidPublicKey);
  let subscription = await withTimeout(registration.pushManager.getSubscription(), "구독 조회");
  const current = subscription?.options.applicationServerKey;
  if (subscription !== null && current !== null && current !== undefined && !sameBytes(new Uint8Array(current), key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await withTimeout(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), "푸시 구독");
  await api.subscribePush(subscription.toJSON(), deviceLabel());
}

function sameBytes(lhs: Uint8Array, rhs: Uint8Array): boolean {
  return lhs.length === rhs.length && lhs.every((byte, index) => byte === rhs[index]);
}
