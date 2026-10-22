/**
 * 앱 업데이트 — release 브랜치의 CI 빌드(`.github/workflows/mac.yml`)가 GitHub 릴리스에 올린 zip 을 받아 두고
 * 앱이 끝날 때 갈아 끼운다(`update-apply.ts`). 스스로 다시 뜨지 않는다 — 도는 세션을 끊지 않는다.
 * [다시 시작해 업데이트]만 다시 띄우고, 턴이 도는 세션이 있으면 그것도 거절한다.
 *
 * 받는 설치본은 번들이 말한다: release 브랜치 빌드만 `build.json` 에 받을 릴리스 주소(`releases`)를 싣는다(`scripts/build-mac.sh`).
 * 개발 실행·이 기기에서 지은 빌드는 받지 않는다. 새것인지는 버전으로 가른다 — 릴리스는 `mac/package.json` 의 version 이고
 * 같은 버전은 다시 내지 않는다. 받아 둔 빌드는 최신 릴리스와 같을 때만 남긴다 — 릴리스를 지우면 받아 둔 것도 버린다.
 *
 * 받아 두기 전에 셋을 대조한다: 명세의 크기·체크섬, 서명(온전한지와 지금 번들의 요건), 번들 안의 빌드 정보.
 * 요건은 서명 신원이 있으면(Developer ID) 지금 번들의 지정 요건이고, ad-hoc 이면 번들 ID 다 — ad-hoc 의 지정 요건은
 * cdhash 라 어떤 새 빌드도 만족하지 못한다. 그때 믿는 것은 손으로 dmg 를 받을 때와 같은 GitHub 릴리스 하나다.
 *
 * 자리(`directory`): `download/`(받는 zip) → `staged.tmp/`(풀어 대조) → `staged/<이름>.app` + `staged/release.json`(대조를 마쳤다는 표식).
 * 주소는 GitHub 릴리스 페이지(`https://github.com/<owner>/<name>/releases`)이고 그 아래 `latest/download/<명세>` 와
 * `download/<태그>/<zip>` 을 읽는다. 공개 레포라 로그인 없이 받는다
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { applyCommand, detach } from "./update-apply";

/** 릴리스마다 zip 과 함께 올리는 명세 — `scripts/build-mac.sh` 가 짓는다 */
export const UPDATE_MANIFEST = "light-update.json";

/** [다시 시작해 업데이트]를 누른 뒤 이 안에 끝나야 다시 띄운다 */
const RELAUNCH_WINDOW_MS = 60_000;
/** 기동 직후는 피한다 — 데몬 기동·온보딩과 겹치지 않게 */
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 60 * 60_000;
const MANIFEST_TIMEOUT_MS = 60_000;
/** zip 은 150MB 안팎이다 */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** Electron 번들의 깊은 서명 검사는 수 초 걸린다 */
const VERIFY_TIMEOUT_MS = 5 * 60_000;
const STAGED = "staged";
const UNPACKED = "staged.tmp";
const DOWNLOAD = "download";

/** 번들의 빌드 정보(`Contents/Resources/build.json`) */
export interface BuildStamp {
  version: string;
  commit?: string;
  committedAt?: string;
  /** 받을 릴리스 주소 — release 브랜치 빌드만 갖는다 */
  releases?: string;
}

/** 릴리스의 명세 — 번들의 빌드 정보에 올린 zip 을 더한 것 */
export interface ReleaseManifest {
  version: string;
  commit: string;
  committedAt: string;
  releases: string;
  tag: string;
  asset: string;
  arch: string;
  sha256: string;
  size: number;
}

export type UpdateStatus = "off" | "idle" | "checking" | "downloading" | "ready" | "failed";

/** 설정 창과 메뉴바가 그리는 값 */
export interface UpdateState {
  current: string;
  status: UpdateStatus;
  detail: string;
  canCheck: boolean;
  /** 받아 둔 버전 — 있으면 [다시 시작해 업데이트]를 보인다 */
  staged: string | null;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 시험 seam */
export interface UpdateSeams {
  /** 지금 도는 번들 — 개발 실행은 없다 */
  bundlePath: string | undefined;
  directory: string;
  arch: string;
  /** 캐시하지 않는다 — Electron 의 net.fetch 는 받은 zip 을 앱 캐시(userData/Cache)에 통째로 쌓는다 */
  fetch(url: string, init: { signal: AbortSignal; cache: "no-store" }): Promise<Response>;
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
  now(): number;
  detach(executable: string, args: string[], logPath: string): void;
}

export interface UpdateHooks {
  changed(state: UpdateState): void;
  /** 새 버전을 받아 두었다 — 버전마다 한 번 */
  ready(version: string): void;
}

/** 실행 파일(`Contents/MacOS/<이름>`)에서 번들을 찾는다 — `.app` 안이 아니면 개발 실행이다 */
export function bundleOf(executable: string): string | undefined {
  const bundle = dirname(dirname(dirname(executable)));
  return basename(dirname(executable)) === "MacOS" && bundle.endsWith(".app") ? bundle : undefined;
}

export function realSeams(fetch: UpdateSeams["fetch"], executable: string, directory: string, packaged: boolean): UpdateSeams {
  return {
    bundlePath: packaged ? bundleOf(executable) : undefined,
    directory,
    arch: process.arch,
    fetch,
    run: (command, args, timeoutMs) => new Promise((resolve) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      });
    }),
    now: () => Date.now(),
    detach,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseStamp(value: unknown): BuildStamp | undefined {
  if (!isRecord(value) || typeof value.version !== "string") return undefined;
  const stamp: BuildStamp = { version: value.version };
  const commit = optionalString(value.commit);
  const committedAt = optionalString(value.committedAt);
  const releases = optionalString(value.releases);
  if (commit !== undefined) stamp.commit = commit;
  if (committedAt !== undefined) stamp.committedAt = committedAt;
  if (releases !== undefined && /^https?:\/\//.test(releases)) stamp.releases = releases.replace(/\/+$/, "");
  return stamp;
}

/** 이름은 주소와 경로에 들어간다 — 경로를 넘나드는 글자를 받지 않는다 */
const SAFE_NAME = /^[\w.+-]+$/;

export function parseManifest(value: unknown): ReleaseManifest | undefined {
  if (!isRecord(value)) return undefined;
  const { version, commit, committedAt, releases, tag, asset, arch, sha256, size } = value;
  const strings = [version, commit, committedAt, releases, tag, asset, arch, sha256];
  if (!strings.every((item) => typeof item === "string" && item !== "")) return undefined;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return undefined;
  if (!SAFE_NAME.test(tag as string) || !SAFE_NAME.test(asset as string) || !/^[0-9a-f]{64}$/i.test(sha256 as string)) return undefined;
  return { version, commit, committedAt, releases, tag, asset, arch, sha256, size } as ReleaseManifest;
}

function readStamp(bundle: string): BuildStamp | undefined {
  try {
    return parseStamp(JSON.parse(readFileSync(join(bundle, "Contents", "Resources", "build.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** `x.y.z` 를 견준다 — 읽지 못하는 버전은 새것으로 보지 않는다 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())?.slice(1).map(Number);
  const next = parse(candidate);
  const now = parse(current);
  if (next === undefined || now === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index]! !== now[index]!) return next[index]! > now[index]!;
  }
  return false;
}

function appIn(directory: string): string | undefined {
  try {
    return readdirSync(directory).find((name) => name.endsWith(".app"));
  } catch {
    return undefined;
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureReason(result: CommandResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");
  return text !== "" ? text : `종료 코드 ${result.code}`;
}

export class AppUpdater {
  private stamp: BuildStamp | undefined;
  /** 새 번들이 만족해야 할 서명 요건 — 받는 설치본일 때만 있다 */
  private requirement: string | undefined;
  private status: UpdateStatus = "off";
  private detail = "업데이트를 받을지 살피고 있습니다.";
  private staged: ReleaseManifest | undefined;
  /** 알린 버전 — 기동 때 되살린 것도 알린 것으로 친다 */
  private announced: string | undefined;
  private relaunchUntil = 0;
  private handedOff = false;
  private checking: Promise<void> | undefined;

  constructor(private readonly hooks: UpdateHooks, private readonly seams: UpdateSeams) {}

  get value(): UpdateState {
    return {
      current: this.currentLabel(),
      status: this.status,
      detail: this.detail,
      canCheck: this.receiving && this.status !== "checking" && this.status !== "downloading",
      staged: this.staged?.version ?? null,
    };
  }

  /** 받는 설치본이다 — 릴리스 빌드이고 서명을 대조할 수 있다 */
  get receiving(): boolean {
    return this.requirement !== undefined;
  }

  /** 번들을 읽어 받을지 정하고, 지난번에 받아 둔 빌드를 되살린다 */
  async start(): Promise<void> {
    const bundle = this.seams.bundlePath;
    if (bundle === undefined) return this.set("off", "개발 실행이라 업데이트를 받지 않습니다.");
    this.stamp = readStamp(bundle);
    if (this.stamp === undefined) return this.set("off", "번들의 빌드 정보(build.json)를 읽지 못해 업데이트를 받지 않습니다.");
    if (this.stamp.releases === undefined) return this.set("off", "이 기기에서 지은 빌드라 업데이트를 받지 않습니다. Releases 의 빌드를 설치하면 그 뒤로 스스로 받습니다.");
    // 디스크 이미지나 격리된 자리(App Translocation)에서 연 앱은 설치본 자리를 바꿀 수 없다
    if (bundle.includes("/AppTranslocation/") || !this.writable(dirname(bundle))) {
      return this.set("off", `light 가 있는 자리(${dirname(bundle)})를 바꿀 수 없어 업데이트를 받지 않습니다. 응용 프로그램 폴더로 옮긴 뒤 여십시오.`);
    }
    const signature = await this.seams.run("codesign", ["-dv", "-r-", bundle], 60_000).catch((error: unknown) => ({ code: 1, stdout: "", stderr: describeError(error) }));
    const designated = /^(?:# )?designated => (.+)$/m.exec(signature.stdout)?.[1]?.trim();
    const identifier = /^Identifier=(.+)$/m.exec(signature.stderr)?.[1]?.trim();
    if (signature.code !== 0 || designated === undefined || identifier === undefined) {
      return this.set("off", `이 번들의 서명을 읽지 못해 업데이트를 받지 않습니다. ${failureReason(signature)}`);
    }
    this.requirement = /\bcdhash\b/.test(designated) ? `identifier "${identifier}"` : designated;
    this.restoreStaged();
    if (this.staged !== undefined) this.setReady();
    else this.set("idle", "곧 새 버전을 확인합니다.");
  }

  /** 최신 릴리스를 묻고 새것이면 받아 둔다. 겹쳐 부르면 도는 것을 기다린다 */
  check(): Promise<void> {
    if (!this.receiving) return Promise.resolve();
    this.checking ??= this.runCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /** [다시 시작해 업데이트] — 다음 종료에서 갈아 끼운 뒤 다시 띄운다. 끄는 것과 바쁜지 재는 것은 앱이 한다 */
  restart(): void {
    if (this.staged === undefined) throw new Error("받아 둔 버전이 없습니다.");
    this.relaunchUntil = this.seams.now() + RELAUNCH_WINDOW_MS;
  }

  /** 앱이 끝날 때 — 받아 둔 빌드가 있으면 갈아 끼울 셸을 떼어 띄운다 */
  handOff(appPID: number, daemonPID: number | undefined): boolean {
    const target = this.seams.bundlePath;
    if (this.handedOff || this.staged === undefined || target === undefined) return false;
    this.handedOff = true;
    const { directory } = this.seams;
    const { executable, args } = applyCommand({ appPID, daemonPID, directory, target, relaunch: this.seams.now() <= this.relaunchUntil });
    this.seams.detach(executable, args, join(directory, "apply.log"));
    return true;
  }

  private writable(path: string): boolean {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async runCheck(): Promise<void> {
    const current = this.stamp!;
    this.set("checking", "새 버전을 확인하고 있습니다.");
    let release: ReleaseManifest;
    try {
      const response = await this.seams.fetch(
        `${current.releases}/latest/download/${UPDATE_MANIFEST}`, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS), cache: "no-store" },
      );
      if (response.status === 404) return this.fail("확인하지 못했습니다. 최신 릴리스에 업데이트 명세가 없습니다.");
      if (!response.ok) return this.fail(`확인하지 못했습니다. GitHub 가 ${response.status} 로 답했습니다.`);
      const parsed = parseManifest(await response.json());
      if (parsed === undefined) return this.fail("확인하지 못했습니다. 릴리스의 명세를 읽지 못했습니다.");
      release = parsed;
    } catch (error) {
      return this.fail(`확인하지 못했습니다. ${describeError(error)}`);
    }
    if (this.staged?.version === release.version && this.staged.commit === release.commit) return this.setReady();
    // 받아 둔 것이 최신 릴리스가 아니다 — 새것에 밀렸거나 릴리스가 지워졌다
    if (this.staged !== undefined) this.dropStaged();
    if (!isNewerVersion(release.version, current.version)) return this.set("idle", `최신입니다. ${clock(this.seams.now())} 에 확인했습니다.`);
    if (release.arch !== this.seams.arch) return this.fail(`${release.version} 은 ${release.arch} 빌드라 이 Mac(${this.seams.arch})에서 받지 않습니다.`);

    this.set("downloading", `${release.version} 을 받고 있습니다.`);
    const reason = await this.fetchRelease(release);
    this.clean(DOWNLOAD, UNPACKED);
    if (reason !== undefined) return this.fail(`${release.version} 을 받지 않았습니다. ${reason}`);
    this.setReady();
    if (this.announced !== release.version) {
      this.announced = release.version;
      this.hooks.ready(release.version);
    }
  }

  /** 받아 풀고 대조한 뒤 받아 둔다 — 실패하면 그 까닭 */
  private async fetchRelease(release: ReleaseManifest): Promise<string | undefined> {
    const { directory, run } = this.seams;
    const download = join(directory, DOWNLOAD);
    const unpacked = join(directory, UNPACKED);
    this.clean(DOWNLOAD, UNPACKED);
    try {
      mkdirSync(download, { recursive: true });
      const zip = join(download, release.asset);
      const response = await this.seams.fetch(
        `${this.stamp!.releases}/download/${release.tag}/${release.asset}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), cache: "no-store" },
      );
      if (!response.ok || response.body === null) return `GitHub 가 ${response.status} 로 답했습니다.`;
      const hash = createHash("sha256");
      let size = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), tap, createWriteStream(zip));
      if (size !== release.size || hash.digest("hex") !== release.sha256.toLowerCase()) return "받은 파일의 크기나 체크섬이 명세와 다릅니다.";
      // ditto 로 푼다 — Electron 번들의 심볼릭 링크와 확장 속성을 그대로 살린다(서명이 거기에 기댄다)
      const unzip = await run("ditto", ["-x", "-k", zip, unpacked], VERIFY_TIMEOUT_MS);
      if (unzip.code !== 0) return `압축을 풀지 못했습니다. ${failureReason(unzip)}`;
      const name = appIn(unpacked);
      if (name === undefined) return "받은 파일에 앱 번들이 없습니다.";
      const app = join(unpacked, name);
      // 격리 표식이 달려 있으면 Gatekeeper 가 공증 없는 번들을 막아 갈아 끼운 앱이 뜨지 않는다
      await run("xattr", ["-dr", "com.apple.quarantine", app], 60_000);
      const sealed = await run("codesign", ["--verify", "--deep", "--strict", app], VERIFY_TIMEOUT_MS);
      if (sealed.code !== 0) return `서명이 온전하지 않습니다. ${failureReason(sealed)}`;
      const same = await run("codesign", ["--verify", "-R", `=${this.requirement}`, app], VERIFY_TIMEOUT_MS);
      if (same.code !== 0) return "서명이 이 설치본과 다릅니다.";
      const inside = readStamp(app);
      if (inside?.version !== release.version || inside.commit !== release.commit) return "번들의 빌드 정보가 명세와 다릅니다.";

      // 대조를 마쳤다 — 끝날 때 반쪽 번들을 옮기지 않게 표식(release.json)은 번들을 옮긴 뒤에 쓴다
      const staged = join(directory, STAGED);
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged);
      renameSync(app, join(staged, name));
      writeFileSync(join(staged, "release.json"), JSON.stringify(release));
      this.staged = release;
      return undefined;
    } catch (error) {
      return describeError(error);
    }
  }

  /** 기동 때 — 지난번에 받아 둔 빌드가 지금 것보다 새것이면 되살리고, 아니면(이미 갈아 끼웠다) 지운다 */
  private restoreStaged(): void {
    this.clean(DOWNLOAD, UNPACKED);
    const staged = join(this.seams.directory, STAGED);
    let release: ReleaseManifest | undefined;
    try {
      release = parseManifest(JSON.parse(readFileSync(join(staged, "release.json"), "utf8")));
    } catch {
      release = undefined;
    }
    if (release !== undefined && appIn(staged) !== undefined && isNewerVersion(release.version, this.stamp!.version)) {
      this.staged = release;
      this.announced = release.version;
      return;
    }
    this.dropStaged();
  }

  private dropStaged(): void {
    this.staged = undefined;
    this.clean(STAGED);
  }

  private clean(...names: string[]): void {
    for (const name of names) rmSync(join(this.seams.directory, name), { recursive: true, force: true });
  }

  private setReady(): void {
    this.set("ready", `${this.staged!.version} 을 받아 두었습니다. light 를 끄면 바뀝니다.`);
  }

  private fail(detail: string): void {
    this.set("failed", detail);
  }

  private set(status: UpdateStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    this.hooks.changed(this.value);
  }

  private currentLabel(): string {
    if (this.seams.bundlePath === undefined) return "개발 실행";
    const stamp = this.stamp;
    if (stamp === undefined) return "알 수 없는 빌드";
    return [`light ${stamp.version}`, ...(stamp.commit !== undefined ? [stamp.commit.slice(0, 7)] : []), ...(stamp.releases === undefined ? ["이 기기에서 지은 빌드"] : [])].join(" · ");
  }
}
