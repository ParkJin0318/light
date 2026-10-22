/**
 * 첨부 — 이미지는 기기에서 긴 변 2000px·500KB 안으로 줄이고 JPEG 로 눌러 올린다(HEIC 사진도 여기서 JPEG 가 된다).
 * 이미지는 base64 로 기록에 남아 매 턴 맥락을 먹는다 — 데스크톱 앱도 같은 상한으로 다시 굽는다(번들 판독).
 * 500KB 안의 PNG 스크린샷은 글자가 뭉개지지 않게 그대로 둔다. 올리는 진행률과 실패 재시도를 준다
 */
import type { UploadInfo } from "../../shared/src/protocol.ts";
import { upload } from "./api.ts";

export interface Attachment {
  key: string;
  kind: "image" | "file";
  name: string;
  /** 이미지 미리보기 */
  previewURL?: string;
  progress: number;
  status: "preparing" | "uploading" | "done" | "failed";
  error?: string;
  info?: UploadInfo;
  /** 다시 올릴 본문 */
  blob?: Blob;
}

const LONG_SIDE = 2000;
const TARGET_BYTES = 500_000;

function toJPEG(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("이미지를 줄이지 못했습니다.")) : resolve(blob)), "image/jpeg", quality);
  });
}

/** 긴 변 2000px 안에서 500KB 를 넘지 않을 때까지 품질을 낮추고, 그래도 크면 한 변을 3/4 로 줄여 다시 굽는다. 끝내 크면 마지막 것을 싣는다 */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === "image/gif" && file.size <= TARGET_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    if (file.type === "image/png" && scale === 1 && file.size <= TARGET_BYTES) return file;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("이미지를 줄이지 못했습니다.");
    let last: Blob | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.75, 0.65]) {
        last = await toJPEG(canvas, quality);
        if (last.size <= TARGET_BYTES) return last;
      }
      scale *= 0.75;
    }
    return last ?? file;
  } finally {
    bitmap.close();
  }
}

export function imageName(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  return file.type === "image/png" || file.type === "image/gif" ? file.name || `${base}.png` : `${base}.jpg`;
}

export async function startUpload(attachment: Attachment, update: (change: Partial<Attachment>) => void): Promise<void> {
  if (attachment.blob === undefined) return;
  update({ status: "uploading", progress: 0, error: undefined });
  try {
    const info = await upload(attachment.blob, attachment.name, attachment.kind, (progress) => update({ progress }));
    update({ status: "done", progress: 1, info });
  } catch (error) {
    update({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}
