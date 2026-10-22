/**
 * 첨부 — 기기가 올린 것을 먼저 `uploads/_staging/<id>/` 에 받고, 메시지를 보낼 때 세션 폴더로 옮긴다.
 * 이미지는 user 메시지의 base64 image 블록으로 싣고(streaming input 모드에서만 된다), 작은 PDF 는 document 블록으로 싣는다
 * (모델이 도구 없이 바로 읽는다, 2026-10-22 실측). 그 밖의 파일은 `uploads/<session id>/` 에 두고 프롬프트 머리에 `@"절대경로"` 로 붙인다.
 * 파일 이름은 데몬이 다시 짓고 첨부 폴더 밖에는 쓰지 않는다
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_LIMITS, type UploadInfo } from "../../shared/src/protocol.ts";

const UPLOAD_ID = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** 사람이 알아볼 이름은 남기되 경로 문자·숨김 파일·제어 문자는 없앤다 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").trim();
  const limited = [...cleaned].slice(-80).join("");
  return limited === "" ? "file" : limited;
}

/** 이미지 형식은 기기가 준 값 대신 머리 바이트로 정한다 — API 가 받는 넷만 */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

/** PDF 의 쪽 수 — 압축하지 않은 쪽 객체만 센다. 객체 스트림에 든 쪽은 못 세어 0 이다(모른다) */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

function isPDF(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export interface ConsumedAttachments {
  images: { id: string; mediaType: string; data: string }[];
  /** document 블록으로 실을 PDF */
  documents: { title: string; data: string }[];
  files: string[];
}

export class Uploads {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "_staging"), { recursive: true, mode: 0o700 });
  }

  private stagingDirectory(id: string): string {
    return join(this.root, "_staging", id);
  }

  async save(body: ArrayBuffer, input: { name: string; kind: "image" | "file"; mediaType?: string }): Promise<UploadInfo> {
    const bytes = new Uint8Array(body);
    const limit = input.kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
    if (bytes.byteLength === 0) throw new UploadError("빈 파일입니다.");
    if (bytes.byteLength > limit) throw new UploadError(`파일이 너무 큽니다(최대 ${Math.round(limit / 1024 / 1024)}MB).`, 413);
    let mediaType = input.mediaType ?? "application/octet-stream";
    if (input.kind === "image") {
      const sniffed = sniffImage(bytes);
      if (sniffed === undefined) throw new UploadError("JPEG·PNG·GIF·WebP 이미지만 받습니다.", 415);
      mediaType = sniffed;
    }
    const id = randomUUID().replaceAll("-", "");
    const name = safeFileName(input.name);
    const directory = this.stagingDirectory(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), bytes, { mode: 0o600 });
    const info: UploadInfo = { id, kind: input.kind, name, size: bytes.byteLength, mediaType };
    writeFileSync(join(directory, ".meta.json"), JSON.stringify(info), { mode: 0o600 });
    return info;
  }

  info(id: string): UploadInfo | undefined {
    if (!UPLOAD_ID.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.stagingDirectory(id), ".meta.json"), "utf8")) as UploadInfo;
    } catch {
      return undefined;
    }
  }

  /** 세션의 첨부 폴더 — 세션이 이 폴더를 읽을 수 있게 연다(사람이 일부러 붙인 파일이라 다시 묻지 않는다) */
  sessionDirectory(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new UploadError("세션 id 가 맞지 않습니다.");
    const directory = join(this.root, sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /**
   * 보낼 때 — 이미지는 본문을 읽어 블록으로, 파일은 세션 폴더로 옮겨 경로로. 상한을 넘으면 아무것도 옮기지 않고 던진다
   */
  consume(ids: readonly string[], sessionId: string): ConsumedAttachments {
    if (!SESSION_ID.test(sessionId)) throw new UploadError("세션 id 가 맞지 않습니다.");
    const infos = ids.map((id) => {
      const info = this.info(id);
      if (info === undefined) throw new UploadError("첨부를 찾지 못했습니다. 다시 올려 주십시오.", 404);
      return info;
    });
    const imageCount = infos.filter((info) => info.kind === "image").length;
    if (imageCount > ATTACHMENT_LIMITS.imagesPerMessage) throw new UploadError(`이미지는 한 메시지에 ${ATTACHMENT_LIMITS.imagesPerMessage}장까지입니다.`);
    if (infos.length - imageCount > ATTACHMENT_LIMITS.filesPerMessage) throw new UploadError(`파일은 한 메시지에 ${ATTACHMENT_LIMITS.filesPerMessage}개까지입니다.`);
    const result: ConsumedAttachments = { images: [], documents: [], files: [] };
    const sessionDirectory = join(this.root, sessionId);
    for (const info of infos) {
      const source = join(this.stagingDirectory(info.id), info.name);
      const document = info.kind === "file" && info.size <= ATTACHMENT_LIMITS.documentBytes ? readableDocument(source) : undefined;
      if (info.kind === "image") {
        result.images.push({ id: info.id, mediaType: info.mediaType, data: readFileSync(source).toString("base64") });
      } else if (document !== undefined) {
        result.documents.push({ title: info.name, data: document });
      } else {
        mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
        const target = join(sessionDirectory, `${info.id.slice(0, 8)}-${info.name}`);
        renameSync(source, target);
        result.files.push(target);
      }
      rmSync(this.stagingDirectory(info.id), { recursive: true, force: true });
    }
    return result;
  }

  /**
   * 세션 첨부 폴더 정리 — `keep` 이 버려도 된다고 답한 세션의 폴더만 지운다. 기록이 그 경로를 가리키므로 기간은 넉넉히 두고(관리자가 정한다)
   * 세션 id 모양이 아닌 폴더는 건드리지 않는다
   */
  cleanupSessions(discard: (sessionId: string, modifiedAt: number) => boolean): string[] {
    const removed: string[] = [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return removed;
    }
    for (const name of names) {
      if (!SESSION_ID.test(name)) continue;
      const path = join(this.root, name);
      try {
        if (!discard(name, statSync(path).mtimeMs)) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(name);
      } catch {
        continue;
      }
    }
    return removed;
  }

  /** 하루 넘게 쓰이지 않은 받아 둔 것을 지운다 */
  cleanupStaging(maxAgeMs = 24 * 60 * 60 * 1000): void {
    const staging = join(this.root, "_staging");
    if (!existsSync(staging)) return;
    for (const name of readdirSync(staging)) {
      const path = join(staging, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
  }
}

/** 바로 읽힐 PDF 면 base64 — 머리가 PDF 이고 쪽을 셀 수 있으며 상한 안일 때만. 아니면 경로로 붙인다 */
function readableDocument(path: string): string | undefined {
  const bytes = readFileSync(path);
  if (!isPDF(bytes)) return undefined;
  const pages = pdfPageCount(bytes);
  return pages > 0 && pages <= ATTACHMENT_LIMITS.documentPages ? bytes.toString("base64") : undefined;
}
