/**
 * 작은 JSON 파일 저장 — 임시 파일에 쓰고 이름을 바꿔 반쯤 쓴 파일이 남지 않게 한다.
 * 읽다 깨진 파일은 기본값으로 읽고 옆에 `.broken` 사본을 남긴다(사람이 들여다볼 수 있게)
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJSON<T>(path: string, parse: (value: unknown) => T, fallback: () => T): T {
  if (!existsSync(path)) return fallback();
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    try {
      copyFileSync(path, `${path}.broken`);
    } catch {
      // 사본을 못 남겨도 기본값으로 간다
    }
    return fallback();
  }
}

export function writeJSON(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}
