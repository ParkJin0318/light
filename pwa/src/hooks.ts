/**
 * 화면 공용 훅 — 해시 라우팅, 넓은 화면(아이패드 가로) 판정, 키보드가 올라온 실제 높이, 떠 있는 머리·도크의 높이,
 * 스크롤 위치, 상대 시각, 알림 켜기, 모델 목록과 노력도 이름
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { EFFORT_LEVELS, type ModelOption, type SessionLifecycle } from "../../shared/src/protocol.ts";
import { api } from "./api.ts";
import { describeError, enablePush, pushSupport } from "./push.ts";
import { setState, toast, toastError, useAppState } from "./store.ts";

export type Route =
  | { name: "list" }
  | { name: "session"; sessionId: string; card?: string }
  | { name: "new" }
  | { name: "settings" };

function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] === "s" && parts[1] !== undefined) {
    const card = params.get("card");
    return { name: "session", sessionId: decodeURIComponent(parts[1]), ...(card !== null ? { card } : {}) };
  }
  if (parts[0] === "new") return { name: "new" };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "list" };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (listener) => {
      window.addEventListener("hashchange", listener);
      return () => window.removeEventListener("hashchange", listener);
    },
    () => location.hash,
  );
  return parseRoute(hash);
}

export function routeHref(route: Route): string {
  return route.name === "session"
    ? `#/s/${encodeURIComponent(route.sessionId)}${route.card !== undefined ? `?card=${encodeURIComponent(route.card)}` : ""}`
    : route.name === "list" ? "#/" : `#/${route.name}`;
}

export function navigate(route: Route, replace = false): void {
  const hash = routeHref(route);
  if (!replace) {
    location.hash = hash;
    return;
  }
  history.replaceState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
  );
}

/**
 * 키보드가 올라오면 iOS 는 레이아웃 뷰포트를 줄이지 않는다 — 보이는 높이를 CSS 변수로 둬서 입력창이 키보드 위에 붙게 한다
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const update = () => {
      // 입력칸에 초점이 없으면 키보드도 없다 — iOS 는 앱을 오가거나 키보드가 내려갈 때 resize 를 내지 않아
      // 키보드가 있던 때의 작은 높이가 남는다(iOS 27 시뮬레이터 실측). 그때는 창 높이와 견줘 큰 쪽을 쓴다
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable);
      const height = typing ? viewport.height : Math.max(viewport.height, window.innerHeight);
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
      // 키보드가 올라와 있으면 홈 막대 몫(safe area)을 비워 둘 까닭이 없다 — 도크가 키보드에 바로 붙는다
      document.documentElement.toggleAttribute("data-keyboard", typing && window.innerHeight - viewport.height > 120);
      // 키보드가 올라오며 iOS 가 문서를 밀어 올린 만큼 되돌린다
      if (viewport.offsetTop > 0) window.scrollTo(0, 0);
    };
    // 초점이 빠진 직후에는 키보드가 아직 내려가는 중이다 — 조금 뒤에 한 번 더 잰다
    const later = () => setTimeout(update, 350);
    const listeners: [EventTarget, string, () => void][] = [
      [viewport, "resize", update], [viewport, "scroll", update], [window, "resize", update], [window, "pageshow", update],
      [document, "visibilitychange", later], [document, "focusin", update], [document, "focusout", later],
    ];
    update();
    for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
    return () => {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    };
  }, []);
}

/** 키보드를 올리는 칸인가 — 글을 받는 칸만. 읽기 전용·꺼진 칸과 날짜·파일 같은 고르개는 키보드를 올리지 않는다 */
const PICKER_INPUTS = new Set(["checkbox", "radio", "range", "color", "file", "image", "button", "submit", "reset", "hidden", "date", "datetime-local", "month", "time", "week"]);
function opensKeyboard(target: EventTarget | null): target is HTMLElement {
  if (target instanceof HTMLInputElement) return !PICKER_INPUTS.has(target.type) && !target.readOnly && !target.disabled;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * 키보드가 올라올 때 iOS 가 화면 전체를 밀지 못하게 한다. iOS 는 초점을 받는 칸이 키보드에 가릴 자리면 문서를 밀어 올리고,
 * 앱 높이가 줄며 그것을 되돌리는 사이 화면 전체가 아래로 튀었다 다시 오른다(iOS 27 시뮬레이터 녹화).
 * 초점이 들어가는 순간에만 칸을 화면 위로 옮겨 두면 iOS 는 밀 까닭이 없고, 그리기 전에 제자리로 돌린 칸은 줄어든 앱 높이를 따라 키보드 위에 선다.
 * 탭은 초점보다 먼저 옮겨야 해서 터치의 기본 동작을 막고 초점을 직접 준다(React Aria 의 usePreventScroll 과 같은 길).
 * 그래서 처음 누를 때 커서는 누른 자리가 아니라 마지막 커서 자리(글 끝)에 선다 — 초점이 있는 칸을 다시 누르면 평소대로다
 */
export function useKeyboardWithoutPan(): void {
  useEffect(() => {
    const ua = navigator.userAgent;
    if (!/iPad|iPhone|iPod/.test(ua) && !(ua.includes("Macintosh") && navigator.maxTouchPoints > 1)) return;
    const viewport = window.visualViewport;
    const lift = (field: HTMLElement) => {
      field.style.transform = "translateY(-2000px)";
      requestAnimationFrame(() => {
        field.style.transform = "";
      });
    };
    // iOS 가 밀어 주지 않으니 스크롤 상자 안의 칸이 줄어든 화면 밖에 남았으면 그 상자만 굴려 보인다
    const reveal = () => {
      const field = document.activeElement;
      if (viewport !== null && opensKeyboard(field) && field.getBoundingClientRect().bottom > viewport.height) field.scrollIntoView({ block: "nearest" });
    };
    let start: { x: number; y: number } | undefined;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch !== undefined ? { x: touch.clientX, y: touch.clientY } : undefined;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const field = event.target;
      const touch = event.changedTouches[0];
      if (!opensKeyboard(field) || field === document.activeElement || start === undefined || touch === undefined) return;
      // 끌다가 칸 위에서 손을 뗀 것은 탭이 아니다
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return;
      event.preventDefault();
      lift(field);
      field.focus({ preventScroll: true });
    };
    // 탭이 아닌 초점 이동(제안 칩·키보드의 이전·다음)은 초점 순간에 옮기는 것으로 족하다
    const onFocusIn = (event: FocusEvent) => {
      if (opensKeyboard(event.target)) lift(event.target);
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    document.addEventListener("focusin", onFocusIn, true);
    viewport?.addEventListener("resize", reveal);
    return () => {
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("focusin", onFocusIn, true);
      viewport?.removeEventListener("resize", reveal);
    };
  }, []);
}

/**
 * 떠 있는 머리·도크의 높이를 부모(화면)의 CSS 변수로 둔다 — 본문은 그만큼 비켜 서고 그 아래로 스크롤된다.
 * 돌려주는 함수를 ref 로 단다(도크는 세션을 받은 뒤에야 붙는다). 높이가 바뀌면 `onChange` 로 알린다(맨 아래를 보던 대화를 맨 아래에 붙여 두려고)
 */
export function useHeightVar(name: string, onChange?: (height: number, previous: number) => void): (element: HTMLElement | null) => void {
  const callback = useRef(onChange);
  callback.current = onChange;
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = element?.parentElement;
    if (element === null || host === null || host === undefined) return;
    let previous = -1;
    const apply = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height === previous) return;
      host.style.setProperty(name, `${height}px`);
      const before = previous;
      previous = height;
      if (before >= 0) callback.current?.(height, before);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => {
      observer.disconnect();
      host.style.removeProperty(name);
    };
  }, [element, name]);
  return setElement;
}

/** 스크롤이 `threshold` 를 넘었는가 — 큰 제목이 머리 밑으로 들어가면 머리에 작은 제목과 면을 켠다 */
export function useScrolledPast(ref: RefObject<HTMLElement | null>, threshold: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => setPast(element.scrollTop > threshold);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [ref, threshold]);
  return past;
}

/**
 * 닫힐 때 나가는 움직임을 다 그린 뒤에 내린다 — `open` 이 꺼져도 `exitMs` 동안 `closing` 으로 남는다.
 * 처음 그린 다음 틀에서 `open` 이 되어 들어오는 전환이 돈다
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: "opening" | "open" | "closing" } {
  const [mounted, setMounted] = useState(open);
  const [state, setPresence] = useState<"opening" | "open" | "closing">(open ? "opening" : "closing");
  useEffect(() => {
    if (open) {
      setMounted(true);
      setPresence("opening");
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPresence("open"));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setPresence("closing");
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted, state };
}

/**
 * 마지막 입력이 키보드였는가 — 시트·메뉴를 열 때 키보드면 첫 단추로 초점을 옮기고, 손가락이면 판에만 둔다.
 * 손가락으로 연 시트의 첫 단추에 초점 고리가 켜지면 고른 것처럼 보인다
 */
let keyboardLast = false;
window.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.altKey && !event.ctrlKey) keyboardLast = true;
}, true);
window.addEventListener("pointerdown", () => {
  keyboardLast = false;
}, true);

export function usedKeyboardLast(): boolean {
  return keyboardLast;
}

/**
 * 알림 켜기와 테스트 알림 — 설정 화면과 첫 진입 안내가 함께 쓴다. 권한은 사람이 누른 단추에서만 물을 수 있다(push.ts).
 * `failure` 는 이번에 켜지 못한 까닭이다 — 토스트는 사라져 폰에서 놓친다
 */
export function usePushSetup() {
  const config = useAppState((state) => state.config);
  const [support, setSupport] = useState(pushSupport);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const enable = () => {
    if (busy || config === undefined) return;
    setBusy(true);
    setFailure(undefined);
    enablePush(config.vapidPublicKey).then((next) => {
      setSupport(next);
      // 열 때의 재등록 실패(pushError)도 이제 풀렸다
      if (next === "granted") setState(({ pushError: _, ...rest }) => rest);
    }, (error: unknown) => {
      // 권한은 받았는데 구독에서 실패했을 수 있다 — 지금 권한 상태로 다시 그린다
      setSupport(pushSupport());
      setFailure(describeError(error));
    }).finally(() => setBusy(false));
  };

  const test = () => {
    if (busy) return;
    setBusy(true);
    api.testPush().then(
      (result) => toast(result.sent > 0 ? "테스트 알림을 보냈습니다." : "보낸 알림이 없습니다. 구독을 다시 등록하니 잠시 뒤 다시 보내십시오."),
      (error: unknown) => toastError(error, "테스트 알림을 보내지 못했습니다. 연결을 확인하고 다시 누르십시오."),
    ).finally(() => setBusy(false));
  };

  return { support, busy, failure, ready: config !== undefined, enable, test };
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "방금";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}일 전`;
  const date = new Date(at);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export const LIFECYCLE_LABELS: Record<SessionLifecycle, string> = {
  starting: "시작 중", running: "실행 중", waitingPermission: "승인 대기", waitingQuestion: "질문 대기", idle: "유휴", closed: "닫힘", error: "오류",
};

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: "권한 요청", acceptEdits: "편집 자동 수락", plan: "계획 모드", bypassPermissions: "권한 건너뛰기",
};

export const PERMISSION_MODE_DETAILS: Record<string, string> = {
  default: "도구를 쓰기 전에 매번 묻습니다",
  acceptEdits: "파일 편집은 묻지 않고 진행합니다",
  plan: "코드를 바꾸지 않고 계획만 세웁니다",
  bypassPermissions: "묻지 않고 진행합니다",
};

export function permissionModeLabel(mode: string): string {
  return PERMISSION_MODE_LABELS[mode] ?? mode;
}

/** set_model 은 별칭을 받는다(실측: sonnet → claude-sonnet-5-5). claude 의 목록을 못 받았을 때 쓴다 */
export const MODEL_CHOICES: { value: string; label: string; detail?: string }[] = [
  { value: "", label: "기본 모델", detail: "Mac 의 claude 설정을 따릅니다" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

let modelsRequested = false;

/** claude 가 알려 준 모델 목록 — 처음 쓸 때 한 번 받는다. 못 받았으면 undefined 이고 화면은 내장 목록을 쓴다 */
export function useModels(): ModelOption[] | undefined {
  const models = useAppState((state) => state.models);
  useEffect(() => {
    if (modelsRequested) return;
    modelsRequested = true;
    api.models().then((result) => {
      if (result.models.length > 0) setState((current) => ({ ...current, models: result.models }));
      else modelsRequested = false;
    }, () => {
      modelsRequested = false;
    });
  }, []);
  return models;
}

/** 모델 시트의 선택지 — claude 의 「default」 줄은 값을 비운다(데몬이 기본 모델로 돌린다) */
export function modelChoices(models: ModelOption[] | undefined): { value: string; label: string; detail?: string }[] {
  if (models === undefined || models.length === 0) return MODEL_CHOICES;
  return models.map((option) => ({
    value: option.value === "default" ? "" : option.value, label: option.label,
    ...(option.description !== undefined ? { detail: option.description } : {}),
  }));
}

/**
 * 지금 모델에 맞는 목록 줄 — 값이 같은 줄, 그다음 실제 id(`resolvedModel`)가 같은 줄(「default」 보다 별칭 줄).
 * 실제 id 를 알려 주지 않는 claude 면 별칭이 이름에 든 가장 긴 줄. 판을 박은 id(claude-opus-5)는 claude-opus-5-5 에도
 * 들어 있어 글자로는 견주지 않는다. 모델이 없으면 「default」 줄
 */
export function findModel(models: ModelOption[] | undefined, model: string | undefined): ModelOption | undefined {
  if (models === undefined) return undefined;
  if (model === undefined || model === "") return models.find((option) => option.value === "default");
  const bare = (id: string) => id.replace(/\[.*\]$/, "").toLowerCase();
  const wanted = bare(model);
  const exact = models.find((option) => bare(option.value) === wanted);
  if (exact !== undefined) return exact;
  const resolved = models.filter((option) => option.resolvedModel !== undefined && bare(option.resolvedModel) === wanted);
  if (resolved.length > 0) return resolved.find((option) => option.value !== "default") ?? resolved[0];
  return models
    .filter((option) => option.value !== "default" && !option.value.startsWith("claude-") && wanted.includes(bare(option.value)))
    .sort((lhs, rhs) => rhs.value.length - lhs.value.length)[0];
}

export const EFFORT_LABELS: Record<string, string> = { low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" };

export function effortLabel(effort: string | undefined): string {
  return effort === undefined || effort === "" ? "기본 노력" : EFFORT_LABELS[effort] ?? effort;
}

/** 노력도를 고를 수 있는 모델인가 — 목록을 모르면 고를 수 있다고 본다(claude 가 받지 않으면 적용값이 비어 돌아온다) */
export function effortsFor(option: ModelOption | undefined, known: boolean): readonly string[] | undefined {
  if (option?.efforts !== undefined) return option.efforts;
  return known && option !== undefined ? undefined : EFFORT_LEVELS;
}

export function modelLabel(model: string | undefined): string {
  if (model === undefined || model === "") return "기본 모델";
  const lowered = model.toLowerCase();
  for (const name of ["fable", "opus", "sonnet", "haiku"]) {
    if (lowered.includes(name)) {
      const version = /(\d+)[-.](\d+)/.exec(lowered);
      return `${name[0]!.toUpperCase()}${name.slice(1)}${version !== null ? ` ${version[1]}.${version[2]}` : ""}`;
    }
  }
  return model;
}
