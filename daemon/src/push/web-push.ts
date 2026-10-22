/**
 * Web Push 전송 — VAPID(RFC 8292)와 aes128gcm 본문 암호화(RFC 8291·8188)를 WebCrypto 로 한다.
 * 본문은 표준대로 암호화돼 Apple 푸시 서비스가 읽지 못한다. 키는 데몬이 처음 뜰 때 만들어 데이터 폴더에 둔다
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJSON } from "../json-file.ts";
import { errorText } from "../log.ts";

/** P-256 개인 키의 JWK 칸 — lib.dom 없이 쓴다 */
export interface PrivateJwk {
  kty?: string;
  crv?: string;
  d?: string;
  x?: string;
  y?: string;
}

export interface VapidKeys {
  /** 비압축 P-256 공개 키(65바이트) base64url — PWA 의 `applicationServerKey` */
  publicKey: string;
  /** JWK 의 d·x·y */
  privateJwk: PrivateJwk;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** 구독이 사라졌다(410·404) — 지운다 */
  gone: boolean;
  error?: string;
}

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64url(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y } };
}

export async function loadOrCreateVapid(path: string): Promise<VapidKeys> {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
      if (typeof parsed.publicKey === "string" && typeof parsed.privateJwk?.d === "string") return parsed;
    } catch {
      // 깨졌으면 새로 — 기존 구독은 다시 등록된다(PWA 를 열 때마다 재구독한다)
    }
  }
  const keys = await generateVapidKeys();
  writeJSON(path, keys);
  return keys;
}

/** `Authorization: vapid t=<JWT>, k=<공개 키>` — 만료는 12시간(상한 24시간) */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...keys.privateJwk, kty: "EC", crv: "P-256" } as never, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto 의 ECDSA 서명은 이미 JWS 가 원하는 r||s(64바이트) 모양이다
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * RFC 8291 — 받는 쪽 공개 키(p256dh)와 auth 비밀로 aes128gcm 본문 한 덩어리를 만든다.
 * 머리: salt(16) | rs(4) | idlen(1) | 보내는 쪽 임시 공개 키(65). 레코드는 하나, 끝 구분자 0x02
 */
export async function encryptPayload(target: PushTarget, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const userPublic = fromBase64url(target.keys.p256dh);
  const authSecret = fromBase64url(target.keys.auth);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const userKey = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userKey }, ephemeral.privateKey, 256));
  const keyInfo = concat(encoder.encode("WebPush: info\0"), userPublic, serverPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(payload, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([serverPublic.byteLength]), serverPublic, ciphertext);
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function sendPush(
  target: PushTarget, payload: unknown, keys: VapidKeys, subject: string,
  options: { urgency?: "high" | "normal"; fetcher?: Fetcher } = {},
): Promise<PushResult> {
  try {
    const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)));
    const response = await (options.fetcher ?? fetch)(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(24 * 3600),
        Urgency: options.urgency ?? "high",
      },
      body,
    });
    const gone = response.status === 404 || response.status === 410;
    if (response.ok) return { ok: true, status: response.status, gone: false };
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, gone, error: `${response.status} ${text.slice(0, 200)}`.trim() };
  } catch (error) {
    return { ok: false, status: 0, gone: false, error: errorText(error) };
  }
}
