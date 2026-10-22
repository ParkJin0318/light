/**
 * README 스크린샷 — 데모 데몬이 띄운 PWA 와 가짜 상태를 넣은 Mac 설정 창(mac/ui)을 찍어 기기 틀에 넣고
 * `docs/images` 에 라이트·다크 두 벌로 쓴다. 틀(신호등·상태 막대·다이내믹 아일랜드)은 CSS 로 그린다.
 * 날것의 화면은 `LIGHT_DEMO_DIR/raw` 에 남는다. `sh scripts/screenshots.sh` 가 데몬을 띄운 뒤 부른다
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import QRCode from "qrcode";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const demo = process.env.LIGHT_DEMO_DIR ?? join(root, ".dev", "screenshots");
const base = `http://127.0.0.1:${process.env.LIGHT_DEMO_PORT ?? 47699}/`;
const raw = join(demo, "raw");
const images = join(root, "docs", "images");
mkdirSync(raw, { recursive: true });
mkdirSync(images, { recursive: true });

const SCHEMES = ["light", "dark"];
/** README 본문 폭(약 880px)의 두 배 */
const FIGURE_WIDTH = 1800;

// MARK: - PWA

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
/** 화면 크기와 안전 영역 — 홈 화면 앱처럼 보이게 `--safe-top`·`--safe-bottom`(pwa/src/styles/tokens.css)을 덮어쓴다 */
const DEVICES = {
  iphone: { viewport: { width: 393, height: 852 }, userAgent: IPHONE_UA, safeTop: 59, safeBottom: 34 },
  ipad: { viewport: { width: 1180, height: 820 }, userAgent: IPAD_UA, safeTop: 24, safeBottom: 20 },
};

async function capturePWA(browser) {
  const ids = JSON.parse(readFileSync(join(demo, "sessions.json"), "utf8"));
  const shots = [
    { name: "iphone-list", device: "iphone", hash: "#/" },
    { name: "iphone-permission", device: "iphone", hash: `#/s/${ids["shop-api"]}` },
    { name: "iphone-question", device: "iphone", hash: `#/s/${ids["ios-app"]}` },
    { name: "ipad-permission", device: "ipad", hash: `#/s/${ids["shop-api"]}` },
  ];
  for (const scheme of SCHEMES) {
    for (const shot of shots) {
      const device = DEVICES[shot.device];
      const context = await browser.newContext({
        viewport: device.viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: device.userAgent,
        colorScheme: scheme, locale: "ko-KR", timezoneId: "Asia/Seoul", reducedMotion: "reduce", bypassCSP: true,
      });
      await context.addInitScript(({ safeTop, safeBottom }) => {
        // 설치·알림 안내 시트(Welcome.tsx)는 닫아 둔다
        try { sessionStorage.setItem("light.installGuideDismissed", "1"); } catch {}
        try { localStorage.setItem("light.pushPrompted", "1"); } catch {}
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = `:root { --safe-top: ${safeTop}px !important; --safe-bottom: ${safeBottom}px !important; }`;
          document.head.append(style);
        });
      }, { safeTop: device.safeTop, safeBottom: device.safeBottom });
      const page = await context.newPage();
      page.on("console", (message) => { if (message.type() === "error") console.log(`[${shot.name}] ${message.text()}`); });
      await page.goto(base + shot.hash, { waitUntil: "networkidle" });
      // 가상 시간이 아니라 실제 시간으로 기다린다 — 목록이 그려질 틈
      await page.waitForTimeout(2_500);
      await page.screenshot({ path: join(raw, `${shot.name}-${scheme}.png`) });
      await context.close();
    }
  }
}

// MARK: - Mac 설정 창

const PWA_URL = "https://macbook.tail1a2b3c.ts.net";

/** 데몬 로컬 API 가 돌려줄 상태 — 메일·주소는 예시 값이다 */
function macStatus(now) {
  return {
    daemon: { state: "running", version: "0.1.0", pid: 4242, port: 47615 },
    counts: { running: 1, alive: 3, pending: 2 },
    tailscale: {
      installed: true, loggedIn: true, dnsName: "macbook.tail1a2b3c.ts.net", loginName: "you@example.com", httpsEnabled: true,
      phones: [{ name: "iphone", online: true }, { name: "ipad", online: true }], backendState: "Running",
    },
    serve: { configured: true, funnel: false, url: PWA_URL },
    pwaUrl: PWA_URL,
    claude: { installed: true, version: "2.1.300", loggedIn: true, subscriptionType: "max" },
    devices: [
      { id: "a", label: "iPhone", installed: true, subscribed: true, lastSeenAt: now - 40_000, lastPushOkAt: now - 6 * 60_000, expiredAt: null },
      { id: "b", label: "iPad", installed: true, subscribed: true, lastSeenAt: now - 3 * 3_600_000, lastPushOkAt: now - 3 * 3_600_000, expiredAt: null },
    ],
    logPath: null,
  };
}

const MAC_SETTINGS = {
  projectFolders: ["/Users/you/code/shop-api", "/Users/you/code/docs-site", "/Users/you/code/ios-app"],
  defaultPermissionMode: "default", defaultEffort: "high", allowedLogins: ["you@example.com"], allowLocalhost: true,
  notifications: { permission: true, question: true, turnDone: true, error: true },
  hideLockScreenBody: false, launchAtLogin: true, preventSleep: true, idleCloseMinutes: 30, prewarm: true,
  turnTools: true, autoContinue: true, writePromptHistory: true, authMode: "subscription", port: 47615,
};

/** 두 창의 높이 — 시작하기가 끝까지 보이는 높이에 설정 창도 맞춘다 */
async function captureMac(browser) {
  const qr = await QRCode.toDataURL(PWA_URL, { margin: 1, width: 280 });
  const ui = pathToFileURL(join(root, "mac", "ui", "index.html")).href;
  let height = 760;
  for (const scheme of SCHEMES) {
    for (const view of ["onboarding", "settings"]) {
      const context = await browser.newContext({ viewport: { width: 720, height }, deviceScaleFactor: 2, colorScheme: scheme, bypassCSP: true, locale: "ko-KR", reducedMotion: "reduce" });
      // preload 의 window.light(mac/src/preload.ts)를 가짜로 — 읽기만 답하고 바꾸는 동작은 아무것도 하지 않는다
      await context.addInitScript(({ status, settings, qr }) => {
        const ok = async () => ({});
        window.light = {
          status: async () => ({ status, error: null }), onStatus: () => {}, onView: () => {},
          settings: async () => settings, updateSettings: async () => settings,
          refreshNetwork: ok, registerServe: ok, testPush: ok, removeDevice: ok, restartDaemon: ok, openLogs: ok,
          qr: async () => qr, copy: ok, openExternal: ok, chooseFolders: async () => [], onboarded: ok,
        };
      }, { status: macStatus(Date.now()), settings: MAC_SETTINGS, qr });
      const page = await context.newPage();
      page.on("console", (message) => { if (message.type() === "error") console.log(`[mac-${view}] ${message.text()}`); });
      await page.goto(`${ui}#${view}`);
      await page.waitForTimeout(1_200);
      if (view === "onboarding") {
        height = await page.evaluate(() => document.querySelector(".scroll").scrollHeight + document.querySelector(".toolbar").getBoundingClientRect().height);
        await page.setViewportSize({ width: 720, height });
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: join(raw, `mac-${view}-${scheme}.png`) });
      await context.close();
    }
  }
  return height;
}

// MARK: - 기기 틀

const SIGNAL = `<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="7.5" width="3.2" height="4.5" rx="1"/><rect x="4.9" y="5.2" width="3.2" height="6.8" rx="1"/><rect x="9.8" y="2.7" width="3.2" height="9.3" rx="1"/><rect x="14.7" y="0" width="3.2" height="12" rx="1"/></svg>`;
const WIFI = `<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.3c2.3 0 4.5.9 6.1 2.4l1.3-1.3A10.6 10.6 0 0 0 8 .4C5.2.4 2.6 1.5.6 3.4l1.3 1.3A8.8 8.8 0 0 1 8 2.3Z"/><path d="M8 6c1.3 0 2.5.5 3.5 1.3l1.3-1.3A6.8 6.8 0 0 0 8 4.1C6.2 4.1 4.5 4.8 3.2 6l1.3 1.3C5.5 6.5 6.7 6 8 6Z"/><path d="M8 11.6 10.2 9.4A3.2 3.2 0 0 0 8 8.5c-.9 0-1.6.3-2.2.9L8 11.6Z"/></svg>`;
const BATTERY = `<svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2.4"/><path d="M25 4.3v4.4c.9-.3 1.4-1.2 1.4-2.2S25.9 4.6 25 4.3Z" fill-opacity=".45"/></svg>`;

const frameCSS = (scheme) => `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: -apple-system, "SF Pro Text", system-ui, sans-serif; color: ${scheme === "dark" ? "#fff" : "#000"}; }
  .stage { display: inline-flex; gap: 56px; padding: 64px 72px 88px; align-items: flex-start; }
  svg { fill: currentColor; display: block; }
  .screen img, .window img { display: block; width: 100%; height: 100%; }
  .home { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); width: 139px; height: 5px; border-radius: 3px; background: currentColor; }

  .phone, .tablet { background: #0d0d0e; position: relative;
    box-shadow: inset 0 0 0 1.5px #55555a, inset 0 0 0 4px #1d1d1f, 0 40px 70px -20px rgba(0,0,0,.45), 0 14px 28px -10px rgba(0,0,0,.25); }
  .phone { padding: 13px; border-radius: 68px; }
  .phone .screen { width: 393px; height: 852px; border-radius: 55px; overflow: hidden; position: relative; }
  .phone .island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 125px; height: 37px; border-radius: 19px; background: #000; }
  .phone .status { position: absolute; inset: 0 0 auto 0; height: 54px; display: grid; grid-template-columns: 1fr 125px 1fr; align-items: center; padding-top: 4px; }
  .phone .time { justify-self: center; font-size: 17px; font-weight: 600; letter-spacing: -.3px; padding-left: 14px; }
  .phone .icons { justify-self: center; display: flex; gap: 6px; align-items: center; padding-right: 8px; }

  .tablet { padding: 20px; border-radius: 40px; }
  .tablet .screen { width: 1180px; height: 820px; border-radius: 20px; overflow: hidden; position: relative; }
  .tablet .status { position: absolute; inset: 0 0 auto 0; height: 24px; display: flex; justify-content: space-between; align-items: center; padding: 2px 22px 0; font-size: 13px; font-weight: 600; }
  .tablet .icons { display: flex; gap: 6px; align-items: center; }
  .tablet .home { width: 300px; bottom: 7px; }

  .window { width: 720px; border-radius: 14px; overflow: hidden; position: relative;
    box-shadow: 0 0 0 .5px ${scheme === "dark" ? "rgba(0,0,0,.9)" : "rgba(0,0,0,.22)"}, 0 30px 70px -10px rgba(0,0,0,${scheme === "dark" ? ".6" : ".32"}), 0 10px 24px -6px rgba(0,0,0,.18); }
  .window::after { content: ""; position: absolute; inset: 0; border-radius: 14px; pointer-events: none; box-shadow: inset 0 0 0 1px ${scheme === "dark" ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.5)"}; }
  /* 신호등 자리는 Mac 앱의 trafficLightPosition(mac/src/main.ts)과 같다 */
  .lights { position: absolute; top: 19px; left: 18px; display: flex; gap: 9px; }
  .lights span { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18); }
  .lights span:nth-child(1) { background: #ff5f57; } .lights span:nth-child(2) { background: #febc2e; } .lights span:nth-child(3) { background: #28c840; }
`;

const src = (name) => pathToFileURL(join(raw, name)).href;
const today = new Intl.DateTimeFormat("ko", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
const phone = (name) => `<div class="phone"><div class="screen"><img src="${src(name)}"><div class="status"><span class="time">9:41</span><span></span><span class="icons">${SIGNAL}${WIFI}${BATTERY}</span></div><div class="island"></div><div class="home"></div></div></div>`;
const tablet = (name) => `<div class="tablet"><div class="screen"><img src="${src(name)}"><div class="status"><span>9:41&nbsp;&nbsp;${today}</span><span class="icons">${WIFI}${BATTERY}</span></div><div class="home"></div></div></div>`;
const macWindow = (name, height) => `<div class="window" style="height:${height}px"><img src="${src(name)}"><div class="lights"><span></span><span></span><span></span></div></div>`;

/** 틀에 넣은 그림을 폭 FIGURE_WIDTH 로 — 배경은 투명이라 GitHub 의 라이트·다크 어느 쪽에도 놓인다 */
async function compose(browser, macHeight) {
  const figures = [
    { name: "pwa-iphone", body: (s) => [phone(`iphone-list-${s}.png`), phone(`iphone-permission-${s}.png`), phone(`iphone-question-${s}.png`)].join("") },
    { name: "pwa-ipad", body: (s) => tablet(`ipad-permission-${s}.png`) },
    { name: "mac", body: (s) => [macWindow(`mac-onboarding-${s}.png`, macHeight), macWindow(`mac-settings-${s}.png`, macHeight)].join("") },
  ];
  for (const scheme of SCHEMES) {
    for (const figure of figures) {
      const file = join(demo, `figure-${figure.name}-${scheme}.html`);
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${frameCSS(scheme)}</style><div class="stage">${figure.body(scheme)}</div>`);
      const probe = await browser.newPage();
      await probe.goto(pathToFileURL(file).href);
      const size = await probe.evaluate(() => {
        const rect = document.querySelector(".stage").getBoundingClientRect();
        return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      });
      await probe.close();
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: FIGURE_WIDTH / size.width });
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(images, `${figure.name}-${scheme}.png`), omitBackground: true });
      await context.close();
      console.log(`docs/images/${figure.name}-${scheme}.png`);
    }
  }
}

/** README 머리의 아이콘 — PWA 아이콘을 둥근 모서리로 */
async function icon(browser) {
  const file = join(demo, "icon.html");
  const source = pathToFileURL(join(root, "pwa", "public", "icons", "icon-512.png")).href;
  writeFileSync(file, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:128px;height:128px;border-radius:29px}</style><img src="${source}">`);
  const context = await browser.newContext({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.screenshot({ path: join(images, "icon.png"), omitBackground: true });
  await context.close();
  console.log("docs/images/icon.png");
}

// 브라우저는 close 로 내린다 — 신호로 죽이면 앱 복제본이 남는다
const browser = await chromium.launch();
try {
  await capturePWA(browser);
  const macHeight = await captureMac(browser);
  await compose(browser, macHeight);
  await icon(browser);
} finally {
  await browser.close();
}
