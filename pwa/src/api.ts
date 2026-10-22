/**
 * 데몬 HTTP API — 같은 출처(serve 주소)로 부른다. 기기 id 를 머리에 싣는다
 */
import type {
  ModelOption, ProjectCandidate, RewindPoint, RewindPreview, RewindScope, SessionSummary, TaskOutput, UploadInfo, ViewItem,
} from "../../shared/src/protocol.ts";
import type { AppConfig } from "./store.ts";

const DEVICE_KEY = "light.deviceId";

/** 기기 id — PWA 를 처음 열 때 만들어 이 기기에 둔다 */
export function deviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    // 저장소를 못 쓰는 창 — 이번 열림만의 id
  }
  if (id === null || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
    id = crypto.randomUUID().replaceAll("-", "");
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // 위와 같다
    }
  }
  return id;
}

export class APIError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "X-Light-Device": deviceId(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = { error: text };
  }
  if (!response.ok) throw new APIError((parsed as { error?: string }).error ?? `요청이 실패했습니다(${response.status}).`, response.status);
  return parsed as T;
}

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  sessions: () => request<{ sessions: SessionSummary[] }>("GET", "/api/sessions"),
  projects: () => request<{ projects: ProjectCandidate[] }>("GET", "/api/projects"),
  models: () => request<{ models: ModelOption[] }>("GET", "/api/models"),
  createSession: (body: { cwd: string; prompt: string; attachments: string[]; model?: string; permissionMode?: string; effort?: string }) =>
    request<{ sessionId: string; summary: SessionSummary }>("POST", "/api/sessions", body),
  resume: (sessionId: string, mode: "resume" | "fork" | "takeover", confirmBusy = false) =>
    request<{ sessionId: string }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/resume`, { mode, confirmBusy }),
  release: (sessionId: string) => request<{ command: string }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/release`, {}),
  patchSession: (sessionId: string, body: { title?: string; archived?: boolean }) =>
    request<{ ok: boolean }>("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, body),
  page: (sessionId: string, before: number, limit = 100) =>
    request<{ firstIndex: number; items: ViewItem[]; epoch: string; seq: number }>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/events?before=${before}&limit=${limit}`),
  taskOutput: (sessionId: string, taskId: string) =>
    request<TaskOutput>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output`),
  rewindPoints: (sessionId: string) => request<{ points: RewindPoint[] }>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/rewind-points`),
  rewind: (sessionId: string, body: { pointId: string; scope: RewindScope; dryRun?: boolean }) =>
    request<{ preview?: RewindPreview; draft?: string }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/rewind`, body),
  subscribePush: (subscription: PushSubscriptionJSON, label: string) =>
    request<{ ok: boolean }>("POST", "/api/push/subscriptions", { deviceId: deviceId(), label, subscription }),
  testPush: () => request<{ sent: number; failed: number }>("POST", "/api/push/test", {}),
};

export function imageURL(sessionId: string, imageId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`;
}

/** 진행률을 보이는 업로드 — fetch 는 올리는 진행을 알려 주지 않는다 */
export function upload(file: Blob, name: string, kind: "image" | "file", onProgress: (fraction: number) => void): Promise<UploadInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/uploads?kind=${kind}&name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader("X-Light-Device", deviceId());
    if (file.type !== "") xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadInfo);
      else reject(new APIError((body as { error?: string }).error ?? `올리지 못했습니다(${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new APIError("Mac 에 닿지 않습니다.", 0));
    xhr.onabort = () => reject(new APIError("취소했습니다.", 0));
    xhr.send(file);
  });
}
