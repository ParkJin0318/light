/**
 * 아이콘을 그린다 — PWA(홈 화면·maskable·apple-touch)와 Mac 메뉴바 템플릿. 의존 없이 PNG 를 직접 쓴다.
 * 모양은 light 자기 것이다: 어두운 바탕 위에 켜진 등 하나. 홈 제목의 lamp-mark(`pwa/src/styles/list.css`)를 그대로 옮기고 나머지는 비운다.
 * `bun scripts/make-icons.ts` 로 다시 그린다
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

type Pixel = [number, number, number, number];
type Painter = (x: number, y: number) => Pixel;

const root = join(dirname(new URL(import.meta.url).pathname), "..");

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, paint: Painter, samples = 4): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const [r, g, b, a] = paint((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          sum[0] += r * a;
          sum[1] += g * a;
          sum[2] += b * a;
          sum[3] += a;
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = sum[3]! / (samples * samples);
      raw[offset] = alpha === 0 ? 0 : Math.round(sum[0]! / sum[3]!);
      raw[offset + 1] = alpha === 0 ? 0 : Math.round(sum[1]! / sum[3]!);
      raw[offset + 2] = alpha === 0 ? 0 : Math.round(sum[2]! / sum[3]!);
      raw[offset + 3] = Math.round(alpha * 255);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

type Rgb = [number, number, number];

const BACKGROUND: Rgb = [25, 23, 21]; // #191715 — 어두운 테마 면(gray-2)
const LAMP: Rgb = [242, 191, 64]; // #f2bf40 — 어두운 테마 등(amber-9)
const LAMP_HIGHLIGHT: Rgb = [248, 214, 122];

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

function roundedSquare(x: number, y: number, inset: number, radius: number): boolean {
  const lo = inset;
  const hi = 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** 번짐의 불투명도 — 등에서 0.32, 반지름의 0.45 에서 0.10, 끝에서 0 */
function glowAlpha(t: number): number {
  if (t >= 1) return 0;
  return t < 0.45 ? 0.32 - (0.22 * t) / 0.45 : (0.1 * (1 - t)) / 0.55;
}

/** 켜진 등 — 등과 빛 테(lamp-mark 의 그림자 고리)와 번짐. `scale` 은 maskable 안전 영역을 위해 줄인다 */
function lamp(x: number, y: number, scale: number): Rgb {
  const dx = (x - 0.5) / scale;
  const dy = (y - 0.5) / scale;
  const distance = Math.hypot(dx, dy);
  // 왼쪽 위가 조금 밝다
  if (distance <= 0.12) return mix(LAMP_HIGHLIGHT, LAMP, Math.min(Math.hypot(dx + 0.019, dy + 0.029) / 0.168, 1));
  const glowed = mix(BACKGROUND, LAMP, glowAlpha(distance / 0.38));
  return distance <= 0.19 ? mix(glowed, LAMP, 0.18) : glowed;
}

function appIcon(scale: number, inset: number, radius: number): Painter {
  return (x, y) => {
    if (inset > 0 && !roundedSquare(x, y, inset, radius)) return [0, 0, 0, 0];
    return [...lamp(x, y, scale), 1];
  };
}

/** 메뉴바 템플릿 — 검은 모양과 투명만(macOS 가 밝기에 맞춰 칠한다). 빛 테는 고리로 그린다 */
function trayIcon(x: number, y: number): Pixel {
  const distance = Math.hypot(x - 0.5, y - 0.5);
  return distance <= 0.21 || Math.abs(distance - 0.378) <= 0.042 ? [0, 0, 0, 1] : [0, 0, 0, 0];
}

const outputs: [string, number, Painter][] = [
  ["pwa/public/icons/icon-192.png", 192, appIcon(1, 0, 0)],
  ["pwa/public/icons/icon-512.png", 512, appIcon(1, 0, 0)],
  ["pwa/public/icons/maskable-512.png", 512, appIcon(0.72, 0, 0)],
  ["pwa/public/icons/apple-touch-icon.png", 180, appIcon(1, 0, 0)],
  ["mac/assets/trayTemplate.png", 18, trayIcon],
  ["mac/assets/trayTemplate@2x.png", 36, trayIcon],
  ["mac/assets/icon-512.png", 512, appIcon(0.9, 0.06, 0.2)],
];

for (const [path, size, painter] of outputs) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png(size, painter));
  console.log(path);
}
