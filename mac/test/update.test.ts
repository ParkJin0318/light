/**
 * 앱 업데이트 — 릴리스 빌드만 받고, 크기·체크섬·서명(이 설치본의 요건)·번들의 빌드 정보를 대조한 뒤에만 받아 둔다.
 * 고정하는 규칙: 개발 실행·이 기기에서 지은 빌드·바꿀 수 없는 자리의 앱은 받지 않는다, 같거나 낮은 버전은 받지 않는다,
 * 검증에 실패하면 아무것도 남기지 않는다, 받아 둔 빌드는 다음 기동에 되살린다, 갈아 끼우기는 앱이 끝날 때 떼어 띄운 셸이 한다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppUpdater, UPDATE_MANIFEST, bundleOf, isNewerVersion, type CommandResult, type UpdateSeams, type UpdateState } from "../src/update";
import { applyCommand } from "../src/update-apply";

const RELEASES = "https://github.com/example/light/releases";
const ADHOC = 'cdhash H"e1024aee231388830d6044085016f106d13ddd4d"';
const DEVELOPER_ID = 'identifier "dev.light.mac" and anchor apple generic and certificate leaf[subject.OU] = ABCDE12345';
const CURRENT = { version: "0.1.0", commit: "abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedAt: "2026-10-22T03:00:00Z", releases: RELEASES };
const NEXT = { version: "0.2.0", commit: "def5678bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", committedAt: "2026-10-23T03:00:00Z", releases: RELEASES };
const ZIP = new TextEncoder().encode("zip-bytes");
const repoRoot = join(import.meta.dir, "..", "..");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

interface World {
  /** 지금 번들의 build.json — null 이면 파일이 없다 */
  current?: object | null;
  /** 지금 번들의 지정 요건 — undefined 면 codesign 이 읽지 못한다 */
  designated?: string | null;
  /** 최신 릴리스의 명세 — 숫자면 GitHub 가 그 상태로 답한다 */
  release?: object | number;
  zip?: Uint8Array;
  /** 받은 번들 안의 build.json — null 이면 풀어도 번들이 없다 */
  inside?: object | null;
  deepVerify?: Partial<CommandResult>;
  requirementVerify?: Partial<CommandResult>;
  /** 번들 자리 — 기본은 임시 폴더의 Applications */
  place?: string;
  bundlePath?: "none";
  arch?: string;
}

function manifest(stamp: typeof NEXT, overrides: object = {}) {
  return {
    ...stamp, tag: `v${stamp.version}`, asset: `light-${stamp.version}-arm64.zip`, arch: "arm64",
    sha256: createHash("sha256").update(ZIP).digest("hex"), size: ZIP.length, ...overrides,
  };
}

function make(world: World = {}) {
  const root = mkdtempSync(join(tmpdir(), "light-update-"));
  roots.push(root);
  const bundle = join(root, world.place ?? "Applications", "light.app");
  const resources = join(bundle, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  const current = world.current === undefined ? CURRENT : world.current;
  if (current !== null) writeFileSync(join(resources, "build.json"), JSON.stringify(current));
  const directory = join(root, "updates");
  const release = world.release ?? manifest(NEXT);
  const calls: string[][] = [];
  const fetched: string[] = [];
  const states: UpdateState[] = [];
  const ready: string[] = [];
  const detached: { executable: string; args: string[]; logPath: string }[] = [];
  let now = Date.parse("2026-10-23T05:00:00Z");
  const designated = world.designated === undefined ? ADHOC : world.designated;

  const seams: UpdateSeams = {
    bundlePath: world.bundlePath === "none" ? undefined : bundle,
    directory,
    arch: world.arch ?? "arm64",
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith(`/${UPDATE_MANIFEST}`)) {
        return typeof release === "number" ? new Response("Not Found", { status: release }) : Response.json(release);
      }
      return new Response(world.zip ?? ZIP);
    },
    run: async (command, args) => {
      calls.push([command, ...args]);
      const ok = (result: Partial<CommandResult> = {}): CommandResult => ({ code: 0, stdout: "", stderr: "", ...result });
      if (command === "codesign" && args[0] === "-dv") {
        if (designated === null) return ok({ code: 1, stderr: "code object is not signed at all" });
        return ok({ stdout: `${designated === ADHOC ? "# " : ""}designated => ${designated}\n`, stderr: `Executable=${bundle}/Contents/MacOS/light\nIdentifier=dev.light.mac\n` });
      }
      if (command === "ditto") {
        const inside = world.inside === undefined ? NEXT : world.inside;
        const app = join(args[3]!, "light.app", "Contents", "Resources");
        mkdirSync(inside === null ? args[3]! : app, { recursive: true });
        if (inside !== null) writeFileSync(join(app, "build.json"), JSON.stringify(inside));
        return ok();
      }
      if (command === "codesign" && args.includes("--deep")) return ok(world.deepVerify);
      if (command === "codesign" && args.includes("-R")) return ok(world.requirementVerify);
      return ok();
    },
    now: () => now,
    detach: (executable, args, logPath) => detached.push({ executable, args, logPath }),
  };
  const updater = new AppUpdater({ changed: (state) => states.push(state), ready: (version) => ready.push(version) }, seams);
  return {
    root, bundle, directory, updater, calls, fetched, states, ready, detached,
    advance: (ms: number) => { now += ms; },
    last: () => states.at(-1)!,
  };
}

describe("받지 않는 설치본", () => {
  test("번들은 실행 파일의 자리로 안다 — .app 밖에서 도는 Electron 은 개발 실행이다", () => {
    expect(bundleOf("/Applications/light.app/Contents/MacOS/light")).toBe("/Applications/light.app");
    expect(bundleOf("/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")).toBe("/repo/node_modules/electron/dist/Electron.app");
    expect(bundleOf("/usr/local/bin/electron")).toBeUndefined();
  });

  test("개발 실행은 묻지 않고 꺼 둔다", async () => {
    const world = make({ bundlePath: "none" });
    await world.updater.start();
    expect(world.updater.receiving).toBe(false);
    expect(world.last()).toMatchObject({ status: "off", current: "개발 실행", canCheck: false });
    expect(world.calls).toEqual([]);
    await world.updater.check();
    expect(world.fetched).toEqual([]);
  });

  test("이 기기에서 지은 빌드(받을 릴리스 주소가 없다)는 받지 않는다", async () => {
    const { releases: _releases, ...local } = CURRENT;
    const world = make({ current: local });
    await world.updater.start();
    expect(world.last()).toMatchObject({ status: "off", current: "light 0.1.0 · abc1234 · 이 기기에서 지은 빌드" });
    expect(world.last().detail).toContain("이 기기에서 지은 빌드");
  });

  test("빌드 정보가 없는 번들은 받지 않는다", async () => {
    const world = make({ current: null });
    await world.updater.start();
    expect(world.last()).toMatchObject({ status: "off", current: "알 수 없는 빌드" });
  });

  test("격리된 자리(App Translocation)나 쓸 수 없는 폴더에서 연 앱은 받지 않는다", async () => {
    const translocated = make({ place: "AppTranslocation/X" });
    await translocated.updater.start();
    expect(translocated.last()).toMatchObject({ status: "off" });
    expect(translocated.last().detail).toContain("응용 프로그램 폴더로 옮긴 뒤");

    const readOnly = make({ place: "Volumes" });
    chmodSync(join(readOnly.root, "Volumes"), 0o555);
    await readOnly.updater.start();
    expect(readOnly.last()).toMatchObject({ status: "off" });
    chmodSync(join(readOnly.root, "Volumes"), 0o755);
  });

  test("서명을 읽지 못하면 받지 않는다", async () => {
    const world = make({ designated: null });
    await world.updater.start();
    expect(world.last()).toMatchObject({ status: "off" });
    expect(world.last().detail).toContain("code object is not signed at all");
  });
});

describe("확인", () => {
  test("명세의 버전이 지금 것과 같으면 최신이다 — 받지 않는다", async () => {
    const world = make({ release: manifest({ ...NEXT, version: CURRENT.version }) });
    await world.updater.start();
    await world.updater.check();
    expect(world.fetched).toEqual([`${RELEASES}/latest/download/${UPDATE_MANIFEST}`]);
    expect(world.last()).toMatchObject({ status: "idle", canCheck: true, staged: null });
    expect(world.last().detail).toStartWith("최신입니다.");
  });

  test("버전은 숫자로 견준다", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.3.0-beta", "0.2.0")).toBe(false);
  });

  test("명세가 없거나 GitHub 가 실패하면 그 까닭을 남기고 다시 확인할 수 있다", async () => {
    const missing = make({ release: 404 });
    await missing.updater.start();
    await missing.updater.check();
    expect(missing.last()).toMatchObject({ status: "failed", canCheck: true });
    expect(missing.last().detail).toContain("업데이트 명세가 없습니다");

    const broken = make({ release: { version: "0.2.0", tag: "../../evil" } });
    await broken.updater.start();
    await broken.updater.check();
    expect(broken.last().detail).toContain("명세를 읽지 못했습니다");
    expect(broken.fetched).toHaveLength(1);
  });

  test("다른 아키텍처의 빌드는 받지 않는다", async () => {
    const world = make({ arch: "x64" });
    await world.updater.start();
    await world.updater.check();
    expect(world.last()).toMatchObject({ status: "failed", staged: null });
    expect(world.fetched).toHaveLength(1);
  });

  test("겹친 확인은 한 번만 돈다", async () => {
    const world = make();
    await world.updater.start();
    await Promise.all([world.updater.check(), world.updater.check()]);
    expect(world.fetched.filter((url) => url.endsWith(UPDATE_MANIFEST))).toHaveLength(1);
  });
});

describe("받기", () => {
  test("새 버전을 받아 크기·체크섬·서명·빌드 정보를 대조한 뒤 받아 두고 한 번 알린다", async () => {
    const world = make();
    await world.updater.start();
    await world.updater.check();
    expect(world.fetched[1]).toBe(`${RELEASES}/download/v0.2.0/light-0.2.0-arm64.zip`);
    expect(world.states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"]);
    expect(world.last()).toMatchObject({ staged: "0.2.0" });
    expect(world.ready).toEqual(["0.2.0"]);
    // ad-hoc 설치본은 지정 요건이 cdhash 라 번들 ID 로 대조한다
    expect(world.calls).toContainEqual(["codesign", "--verify", "-R", '=identifier "dev.light.mac"', join(world.directory, "staged.tmp", "light.app")]);
    expect(existsSync(join(world.directory, "staged", "light.app"))).toBe(true);
    expect(JSON.parse(readFileSync(join(world.directory, "staged", "release.json"), "utf8"))).toMatchObject({ version: "0.2.0" });
    expect(existsSync(join(world.directory, "download"))).toBe(false);
    expect(existsSync(join(world.directory, "staged.tmp"))).toBe(false);

    // 같은 릴리스를 다시 확인하면 받지 않고 알리지도 않는다
    await world.updater.check();
    expect(world.fetched).toHaveLength(3);
    expect(world.ready).toEqual(["0.2.0"]);
    expect(world.last()).toMatchObject({ status: "ready" });
  });

  test("서명 신원이 있는 설치본은 지정 요건 그대로 대조한다", async () => {
    const world = make({ designated: DEVELOPER_ID });
    await world.updater.start();
    await world.updater.check();
    expect(world.calls).toContainEqual(["codesign", "--verify", "-R", `=${DEVELOPER_ID}`, join(world.directory, "staged.tmp", "light.app")]);
  });

  test.each([
    ["체크섬이 다르다", { zip: new TextEncoder().encode("zip-bytez") }, "체크섬"],
    ["크기가 다르다", { release: manifest(NEXT, { size: ZIP.length + 1 }) }, "크기"],
    ["서명이 깨졌다", { deepVerify: { code: 1, stderr: "a sealed resource is missing or invalid" } }, "서명이 온전하지 않습니다"],
    ["다른 신원·번들 ID 로 서명했다", { requirementVerify: { code: 3 } }, "서명이 이 설치본과 다릅니다"],
    ["번들의 빌드 정보가 명세와 다르다", { inside: { ...NEXT, commit: "0000000" } }, "빌드 정보가 명세와 다릅니다"],
    ["zip 에 앱이 없다", { inside: null }, "앱 번들이 없습니다"],
  ] as const)("%s — 아무것도 남기지 않는다", async (_name, world, reason) => {
    const made = make(world as World);
    await made.updater.start();
    await made.updater.check();
    expect(made.last()).toMatchObject({ status: "failed", staged: null, canCheck: true });
    expect(made.last().detail).toContain(reason);
    expect(made.ready).toEqual([]);
    expect(existsSync(join(made.directory, "staged"))).toBe(false);
    expect(existsSync(join(made.directory, "download"))).toBe(false);
    expect(existsSync(join(made.directory, "staged.tmp"))).toBe(false);
  });
});

describe("기동", () => {
  function lay(directory: string, stamp: typeof NEXT) {
    mkdirSync(join(directory, "staged", "light.app"), { recursive: true });
    writeFileSync(join(directory, "staged", "release.json"), JSON.stringify(manifest(stamp)));
    mkdirSync(join(directory, "download"), { recursive: true });
  }

  test("받아 둔 빌드를 되살린다 — 다시 알리지 않는다", async () => {
    const world = make();
    lay(world.directory, NEXT);
    await world.updater.start();
    expect(world.last()).toMatchObject({ status: "ready", staged: "0.2.0" });
    expect(existsSync(join(world.directory, "download"))).toBe(false);
    await world.updater.check();
    expect(world.ready).toEqual([]);
  });

  test("이미 갈아 끼운 빌드(지금 버전과 같다)는 지운다", async () => {
    const world = make();
    lay(world.directory, { ...NEXT, version: CURRENT.version });
    await world.updater.start();
    expect(world.last()).toMatchObject({ status: "idle", staged: null });
    expect(existsSync(join(world.directory, "staged"))).toBe(false);
  });

  test("받아 둔 것이 최신 릴리스가 아니면 버리고 최신을 받는다", async () => {
    const world = make({ release: manifest({ ...NEXT, version: "0.3.0" }), inside: { ...NEXT, version: "0.3.0" } });
    lay(world.directory, NEXT);
    await world.updater.start();
    await world.updater.check();
    expect(world.last()).toMatchObject({ status: "ready", staged: "0.3.0" });
    expect(world.ready).toEqual(["0.3.0"]);
  });
});

describe("다시 시작과 갈아 끼우기", () => {
  test("받아 둔 빌드가 없으면 다시 시작도, 끌 때 갈아 끼우기도 없다", async () => {
    const world = make();
    await world.updater.start();
    expect(() => world.updater.restart()).toThrow("받아 둔 버전이 없습니다.");
    expect(world.updater.handOff(100, 200)).toBe(false);
    expect(world.detached).toEqual([]);
  });

  test("끌 때 떼어 띄운 셸이 갈아 끼운다 — 다시 시작을 누른 직후에만 다시 띄우고 한 번만 띄운다", async () => {
    const world = make();
    await world.updater.start();
    await world.updater.check();
    world.updater.restart();
    world.advance(10_000);
    expect(world.updater.handOff(100, 200)).toBe(true);
    expect(world.updater.handOff(100, 200)).toBe(false);
    expect(world.detached).toHaveLength(1);
    const { executable, args } = applyCommand({ appPID: 100, daemonPID: 200, directory: world.directory, target: world.bundle, relaunch: true });
    expect(world.detached[0]).toEqual({ executable, args, logPath: join(world.directory, "apply.log") });

    const quiet = make();
    await quiet.updater.start();
    await quiet.updater.check();
    quiet.updater.restart();
    quiet.advance(120_000);
    quiet.updater.handOff(100, undefined);
    expect(quiet.detached[0]!.args).toEqual(applyCommand({ appPID: 100, daemonPID: undefined, directory: quiet.directory, target: quiet.bundle, relaunch: false }).args);
  });
});

describe("릴리스 빌드와의 약속", () => {
  test("명세 이름은 빌드 스크립트와 CI 가 올리는 이름과 같다", () => {
    expect(readFileSync(join(repoRoot, "scripts", "build-mac.sh"), "utf8")).toContain(`release/${UPDATE_MANIFEST}`);
    expect(readFileSync(join(repoRoot, ".github", "workflows", "mac.yml"), "utf8")).toContain(`mac/release/${UPDATE_MANIFEST}`);
  });

  test("받을 릴리스 주소는 release 브랜치 빌드에만 실린다", () => {
    const script = readFileSync(join(repoRoot, "scripts", "build-mac.sh"), "utf8");
    expect(script).toContain('STAMP_REPO="${LIGHT_RELEASE_REPO:-}"');
    expect(script).toContain("if (e.STAMP_REPO) stamp.releases = `https://github.com/${e.STAMP_REPO}/releases`;");
    expect(readFileSync(join(repoRoot, ".github", "workflows", "mac.yml"), "utf8")).toContain("LIGHT_RELEASE_REPO: ${{ github.ref == 'refs/heads/release' && github.repository || '' }}");
    expect(readFileSync(join(repoRoot, "mac", "package.json"), "utf8")).toContain('"from": "../.build/build.json"');
  });
});

describe("갈아 끼우기 셸", () => {
  /** 이미 끝난 프로세스의 pid — 앱이 내려간 뒤를 흉내 낸다 */
  function deadPID(): number {
    const child = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]);
    return Number(child.stdout.toString().trim());
  }

  function lay() {
    const root = mkdtempSync(join(tmpdir(), "light-apply-"));
    roots.push(root);
    const directory = join(root, "updates");
    const target = join(root, "Applications", "light.app");
    mkdirSync(join(directory, "staged", "light.app"), { recursive: true });
    writeFileSync(join(directory, "staged", "light.app", "marker"), "new");
    writeFileSync(join(directory, "staged", "release.json"), "{}");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "old");
    return { directory, target };
  }

  test("앱과 데몬이 내려간 뒤 받아 둔 번들로 갈아 끼운다", () => {
    const { directory, target } = lay();
    const { executable, args } = applyCommand({ appPID: deadPID(), daemonPID: deadPID(), directory, target, relaunch: false });
    const result = Bun.spawnSync([executable, ...args]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("바꿨습니다");
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("new");
    expect(existsSync(join(directory, "staged"))).toBe(false);
    expect(existsSync(join(directory, "previous.app"))).toBe(false);
  });

  test("데몬이 없었어도 앱만 내려가면 갈아 끼운다", () => {
    const { directory, target } = lay();
    const { executable, args } = applyCommand({ appPID: deadPID(), daemonPID: undefined, directory, target, relaunch: false });
    expect(Bun.spawnSync([executable, ...args]).exitCode).toBe(0);
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("new");
  });

  test("앱이나 데몬이 내려가지 않으면 갈아 끼우지 않는다 — 다음에 끌 때 다시 한다", () => {
    for (const [appPID, daemonPID] of [[process.pid, deadPID()], [deadPID(), process.pid]] as const) {
      const { directory, target } = lay();
      const { executable, args } = applyCommand({ appPID, daemonPID, directory, target, relaunch: false, waitTicks: 2 });
      const result = Bun.spawnSync([executable, ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain("앱이 내려가지 않아");
      expect(readFileSync(join(target, "marker"), "utf8")).toBe("old");
      expect(existsSync(join(directory, "staged", "light.app"))).toBe(true);
    }
  });
});
