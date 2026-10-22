/**
 * 데몬이 파일로 쥐는 것 셋 — 설정(Mac 앱이 고친다), 세션 색인·폴더별 기억(데몬이 고친다), 기기·푸시 구독.
 * 저장된 행에 필드를 더할 때는 없어도 되는 키로 둔다 — 필수로 두면 기존 행이 조용히 사라진다
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EFFORT_LEVELS, PERMISSION_MODES, type PermissionMode } from "../../shared/src/protocol.ts";
import { defaultSettings, settingsSchema, type LightSettings } from "../../shared/src/settings.ts";
import { readJSON, writeJSON } from "./json-file.ts";

export class SettingsStore {
  private value: LightSettings;
  private readonly listeners = new Set<(settings: LightSettings) => void>();

  constructor(private readonly path: string) {
    this.value = readJSON(path, (raw) => settingsSchema.parse(raw), defaultSettings);
  }

  get current(): LightSettings {
    return this.value;
  }

  /**
   * 준 키만 바꾼다 — `null` 은 그 키를 지운다(기본값으로). 부분 스키마로 먼저 풀면 zod 가 빠진 키에 기본값을 채워
   * 나머지 설정이 기본값으로 돌아간다 — 지금 값에 얹은 뒤 전체 스키마로 검사한다
   */
  update(patch: unknown): LightSettings {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("설정 모양이 맞지 않습니다.");
    const next: Record<string, unknown> = { ...this.value };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(settingsSchema.shape, key)) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.value = settingsSchema.parse(next);
    writeJSON(this.path, this.value);
    for (const listener of this.listeners) listener(this.value);
    return this.value;
  }

  onChange(listener: (settings: LightSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const persistedSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  /** 사람이 붙인 제목 */
  title: z.string().optional(),
  /** 마지막으로 본 자동 제목(AI 제목·첫 프롬프트) — 데몬을 다시 띄운 뒤 기록을 읽기 전에도 목록에 보인다 */
  autoTitle: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastMessage: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  /** 고른 노력도 — 모르는 값이면 행을 버리지 않고 이 키만 버린다 */
  effort: z.enum(EFFORT_LEVELS).optional().catch(undefined),
  fastMode: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** Mac 기록에서 이어받은 세션이다 */
  importedFrom: z.literal("history").optional(),
  forkedFrom: z.string().optional(),
  /** 턴이 도는 동안 그 턴이 시작한 때 — 데몬이 꺼진 뒤 다음 기동에 남아 있으면 끊긴 턴이다(자동 이어 가기) */
  turnActiveAt: z.number().optional().catch(undefined),
});

export type PersistedSession = z.infer<typeof persistedSessionSchema>;

const stateSchema = z.object({
  /** 여러 Mac 을 위한 자리 — 이 데몬의 id */
  hostId: z.string(),
  sessions: z.record(z.string(), persistedSessionSchema).default({}),
  /** 폴더별 마지막 권한 모드 — plan 은 기억하지 않는다 */
  folderModes: z.record(z.string(), z.enum(PERMISSION_MODES)).default({}),
  folderLastUsed: z.record(z.string(), z.number()).default({}),
});

type PersistedState = z.infer<typeof stateSchema>;

export class StateStore {
  private value: PersistedState;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly path: string) {
    this.value = readJSON(path, (raw) => stateSchema.parse(raw), () => ({ hostId: randomUUID(), sessions: {}, folderModes: {}, folderLastUsed: {} }));
    this.flush();
  }

  get hostId(): string {
    return this.value.hostId;
  }

  sessions(): PersistedSession[] {
    return Object.values(this.value.sessions);
  }

  session(id: string): PersistedSession | undefined {
    return Object.hasOwn(this.value.sessions, id) ? this.value.sessions[id] : undefined;
  }

  putSession(session: PersistedSession): void {
    this.value.sessions[session.id] = session;
    this.schedule();
  }

  patchSession(id: string, patch: Partial<PersistedSession>): void {
    const current = this.session(id);
    if (current === undefined) return;
    this.value.sessions[id] = { ...current, ...patch };
    this.schedule();
  }

  folderMode(cwd: string): PermissionMode | undefined {
    return Object.hasOwn(this.value.folderModes, cwd) ? this.value.folderModes[cwd] : undefined;
  }

  rememberFolder(cwd: string, mode: PermissionMode | undefined): void {
    if (mode !== undefined && mode !== "plan") this.value.folderModes[cwd] = mode;
    this.value.folderLastUsed[cwd] = Date.now();
    this.schedule();
  }

  folderLastUsed(): Record<string, number> {
    return { ...this.value.folderLastUsed };
  }

  /** 잦은 갱신(마지막 메시지)을 모아 쓴다 */
  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 500);
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    writeJSON(this.path, this.value);
  }
}

const deviceSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  login: z.string().optional(),
  subscription: z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).optional(),
  /** 구독을 등록한 PWA 의 주소 — VAPID `sub` 로 쓴다 */
  origin: z.string().optional(),
  /** 홈 화면 앱으로 연 기기 — iOS 는 Safari 와 홈 화면 앱의 저장소가 달라 한 폰이 기기 두 줄이 된다 */
  installed: z.boolean().optional(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  lastPushOkAt: z.number().optional(),
  lastPushError: z.string().optional(),
  /** 푸시가 410·404 로 실패해 구독을 지웠다 */
  expiredAt: z.number().optional(),
});

export type Device = z.infer<typeof deviceSchema>;

export class DeviceStore {
  private value: Record<string, Device>;

  constructor(private readonly path: string) {
    this.value = readJSON(path, (raw) => z.record(z.string(), deviceSchema).parse(raw), () => ({}));
  }

  all(): Device[] {
    return Object.values(this.value);
  }

  get(id: string): Device | undefined {
    return Object.hasOwn(this.value, id) ? this.value[id] : undefined;
  }

  /** 기기를 보면 마지막 접속을 남긴다 — 처음 보는 기기는 행을 만든다 */
  touch(id: string, fields: Partial<Device> = {}): Device {
    const now = Date.now();
    const current = this.get(id) ?? { id, createdAt: now, lastSeenAt: now };
    const next = { ...current, ...fields, lastSeenAt: now };
    this.value[id] = next;
    this.save();
    return next;
  }

  patch(id: string, fields: Partial<Device>): void {
    const current = this.get(id);
    if (current === undefined) return;
    this.value[id] = { ...current, ...fields };
    this.save();
  }

  remove(id: string): boolean {
    if (!Object.hasOwn(this.value, id)) return false;
    delete this.value[id];
    this.save();
    return true;
  }

  private save(): void {
    writeJSON(this.path, this.value);
  }
}
