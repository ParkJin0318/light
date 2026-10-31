import { describe, expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAccess } from "../src/folder-access.ts";

describe("폴더 읽기 문", () => {
  test("읽히는 폴더와 없는 폴더는 지나간다", async () => {
    const access = new FolderAccess();
    await access.ensure(mkdtempSync(join(tmpdir(), "light-folder-")));
    await access.ensure(join(tmpdir(), "light-folder-없는-폴더"));
  });

  test("macOS 가 막은 폴더는 켤 곳을 알린다", async () => {
    const access = new FolderAccess({ probe: async () => Promise.reject(Object.assign(new Error("denied"), { code: "EPERM" })) });
    await expect(access.ensure("/Users/me/Documents/p")).rejects.toThrow("전체 디스크 접근");
  });

  test("붙잡힌 폴더는 시한에 돌려보내고, 풀리기 전에는 다시 읽지 않으며, 풀리면 다시 지나간다", async () => {
    let release = () => {};
    let probes = 0;
    const access = new FolderAccess({
      timeoutMs: 30,
      probe: () => {
        probes += 1;
        return probes === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
      },
    });
    await expect(access.ensure("/p")).rejects.toThrow("붙잡고 있습니다");
    // 풀 스레드를 또 붙잡지 않고 곧바로 돌려보낸다
    await expect(access.ensure("/p")).rejects.toThrow("붙잡고 있습니다");
    expect(probes).toBe(1);
    release();
    await Bun.sleep(0);
    await access.ensure("/p");
    expect(probes).toBe(2);
  });

  test("실제 open() 이 붙잡혀도 이벤트 루프는 돈다 — 쓰는 쪽이 없는 FIFO 로 허용 창을 흉내 낸다", async () => {
    const folder = mkdtempSync(join(tmpdir(), "light-fifo-"));
    const fifo = join(folder, "held");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const access = new FolderAccess({ timeoutMs: 200, probe: async (path) => (await open(join(path, "held"), "r")).close() });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    try {
      await expect(access.ensure(folder)).rejects.toThrow("붙잡고 있습니다");
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
      // 쓰는 쪽을 열어 붙잡힌 풀 스레드를 풀어 준다 — 논블로킹이라 읽는 쪽이 없으면 기다리지 않고 던진다
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    }
  });
});
