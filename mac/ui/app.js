// light 설정 창 — 데몬 로컬 API 를 preload 의 window.light 로 부른다
const bridge = window.light;
let current = { status: null, error: null };
let settings = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
// ipcRenderer.invoke 가 붙이는 「Error invoking remote method '…': Error: 」 머리는 사람에게 뜻이 없어 뗀다
const errorText = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
const tabs = $$('[role="tab"]');
const scroller = $(".scroll");

/** 화면 바꾸기 — 칸의 id 는 `view-` 를 붙여 주소의 #settings 가 그 칸으로 스크롤하지 않게 한다 */
function show(view) {
  for (const main of $$(".view")) main.hidden = main.id !== `view-${view}`;
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  scroller.scrollTop = 0;
  history.replaceState(null, "", `#${view}`);
}

const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" });

function time(at) {
  if (at === null || at === undefined) return "없음";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return relative.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), "hour");
  return absolute.format(at);
}

function setStep(id, ok, text) {
  const step = $(`#${id}`);
  step.classList.toggle("done", ok);
  step.querySelector(".step-state").textContent = text;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 목록 줄 — 앞은 이름과 설명, 뒤는 지우는 단추. 단추 이름이 줄마다 같아 줄 제목을 설명으로 잇는다 */
function listRow(id, title, sub, action) {
  const row = element("li", "group-row");
  const text = element("span", "row-text");
  const heading = element("span", "row-title", title);
  heading.id = id;
  text.append(heading);
  if (sub !== undefined) text.append(sub);
  const button = element("button", "btn btn-ghost small danger", action.label);
  button.type = "button";
  button.setAttribute("aria-describedby", id);
  button.addEventListener("click", action.run);
  row.append(text, button);
  return row;
}

let lastQR = "";
async function render() {
  const status = current.status;
  $("#banner").hidden = current.error === null;
  $("#banner-text").textContent = current.error ?? "";

  const tailscale = status?.tailscale;
  setStep("step-tailscale", tailscale?.loggedIn === true,
    tailscale == null ? "확인하는 중…" : !tailscale.installed ? "설치되지 않았습니다." : tailscale.loggedIn ? `로그인됨 — ${tailscale.loginName ?? ""}` : `로그인이 필요합니다(${tailscale.backendState ?? "?"}).`);
  // Mac 의 Tailscale 이 로그인해야 tailnet 의 설정과 기기가 보인다
  const waitingForMac = tailscale == null ? "확인하는 중…" : !tailscale.loggedIn ? "1단계를 마치면 확인합니다." : undefined;
  setStep("step-https", tailscale?.httpsEnabled === true,
    waitingForMac ?? (tailscale.httpsEnabled ? "켜져 있습니다." : "꺼져 있습니다. 관리 콘솔에서 켜고 이 창으로 돌아오면 바로 확인합니다."));
  const serve = status?.serve;
  setStep("step-serve", serve?.configured === true && serve.funnel !== true,
    serve?.funnel === true ? "Funnel 이 켜져 있어 데몬이 접속을 막았습니다. tailscale funnel 을 끄십시오." : serve?.configured === true ? `연결됨 — ${serve.url}` : "아직 등록하지 않았습니다.");
  const phones = tailscale?.phones ?? [];
  const online = phones.filter((phone) => phone.online);
  setStep("step-phone", online.length > 0,
    waitingForMac ?? (online.length > 0 ? `tailnet 에 붙음 — ${online.map((phone) => phone.name).join(", ")}`
      : phones.length > 0 ? `꺼져 있음 — ${phones.map((phone) => phone.name).join(", ")}. 폰의 Tailscale 에서 VPN 을 켜십시오.`
      : `${tailscale.loginName ?? "이 Mac 의"} 계정으로 로그인한 폰이 tailnet 에 아직 없습니다.`));
  const url = status?.pwaUrl ?? null;
  // 홈 화면 앱으로 한 번이라도 연 폰이 있어야 끝난다 — Safari 로만 연 폰은 알림을 받지 못한다
  const devices = status?.devices ?? [];
  const installed = devices.filter((device) => device.installed);
  const inSafari = devices.filter((device) => !device.installed && /^(iPhone|iPad)$/.test(device.label ?? ""));
  setStep("step-install", url !== null && installed.length > 0,
    url === null ? "serve 를 등록하면 주소가 생깁니다."
    : installed.length > 0 ? `홈 화면 앱으로 열림 — ${[...new Set(installed.map((device) => device.label ?? "기기"))].join(", ")}`
    : inSafari.length > 0 ? "Safari 로 열었습니다. 홈 화면에 추가한 light 아이콘으로 다시 여십시오."
    : url);
  const img = $("#qr");
  if (url !== null && url !== lastQR) {
    lastQR = url;
    img.src = await bridge.qr(url);
  }
  img.hidden = url === null;
  const subscribed = devices.filter((device) => device.subscribed);
  setStep("step-push", subscribed.some((device) => device.lastPushOkAt !== null),
    subscribed.length === 0 ? "알림을 켠 기기가 아직 없습니다." : `알림을 켠 기기 ${subscribed.length}대`);

  const claude = status?.claude;
  const facts = [
    ["데몬", status === null ? "닿지 않음" : `${status.daemon.state === "running" ? "실행 중" : "멈춤"} · ${status.daemon.version} · 127.0.0.1:${status.daemon.port}`],
    ["세션", status === null ? "-" : `실행 중 ${status.counts.running} · 떠 있음 ${status.counts.alive} · 대기 요청 ${status.counts.pending}`],
    ["Tailscale", tailscale == null ? "-" : !tailscale.installed ? "설치되지 않음" : `${tailscale.loggedIn ? "로그인됨" : "로그인 필요"} · HTTPS ${tailscale.httpsEnabled ? "켜짐" : "꺼짐"}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}`],
    ["serve", serve == null ? "-" : `${serve.configured ? "연결됨" : "등록 필요"}${serve.funnel ? " · Funnel 켜짐(막음)" : ""}`],
    ["PWA 주소", url ?? "없음"],
    ["Claude Code", claude == null ? "-" : !claude.installed ? "설치되지 않음" : `${claude.version ?? ""} · ${claude.loggedIn ? `로그인됨${claude.subscriptionType ? `(${claude.subscriptionType})` : ""}` : "로그인 필요"}${claude.error ? ` · ${claude.error}` : ""}`],
  ];
  $("#facts").replaceChildren(...facts.map(([key, value]) => {
    const row = element("div", "group-row");
    row.append(element("dt", undefined, key), element("dd", undefined, value));
    return row;
  }));

  const rows = devices.map((device, index) => {
    const sub = element("span", "row-sub");
    if (device.expiredAt !== null) sub.append(element("span", "row-state danger", "구독 만료 — PWA 를 다시 여십시오"), " · ");
    else if (!device.subscribed) sub.append(element("span", "row-state", "알림 꺼짐"), " · ");
    sub.append(`마지막 접속 ${time(device.lastSeenAt)} · 마지막 푸시 성공 ${time(device.lastPushOkAt)}`);
    return listRow(`device-${index}`, device.label ?? "기기", sub, {
      label: "연결 해제",
      run: async () => {
        let failure;
        try {
          await bridge.removeDevice(device.id);
        } catch (error) {
          failure = `연결을 해제하지 못했습니다(${errorText(error)}). 데몬이 도는지 확인하고 다시 누르십시오.`;
        }
        await refresh();
        if (failure !== undefined) {
          current.error = failure;
          void render();
        }
      },
    });
  });
  $("#devices").replaceChildren(...(rows.length > 0 ? rows : [element("li", "group-row empty", "연결된 기기가 없습니다. 시작하기의 QR 로 폰에 설치하면 여기에 보입니다.")]));
}

function renderSettings() {
  if (settings === null) return;
  for (const input of $$("[data-setting]")) {
    const path = input.dataset.setting.split(".");
    const value = path.reduce((object, key) => (object == null ? undefined : object[key]), settings);
    if (input.type === "checkbox") input.checked = value === true;
    else if (Array.isArray(value)) input.value = value.join(", ");
    else input.value = value ?? "";
  }
  const folders = settings.projectFolders.map((folder, index) => {
    const row = listRow(`folder-${index}`, folder, undefined, {
      label: "빼기",
      run: () => save({ projectFolders: settings.projectFolders.filter((candidate) => candidate !== folder) }),
    });
    row.querySelector(".row-title").classList.add("mono");
    return row;
  });
  $("#folders").replaceChildren(...(folders.length > 0 ? folders : [element("li", "group-row empty", "추가한 폴더가 없습니다.")]));
}

async function save(patch) {
  try {
    settings = await bridge.updateSettings(patch);
    renderSettings();
  } catch (error) {
    current.error = `설정을 저장하지 못했습니다(${errorText(error)}). 데몬이 도는지 확인하고 다시 바꾸십시오.`;
    render();
    // 칸은 저장된 값으로 돌려 둔다 — 저장되지 않은 값이 저장된 것처럼 보이지 않게
    renderSettings();
  }
}

for (const input of $$("[data-setting]")) {
  input.addEventListener("change", () => {
    const path = input.dataset.setting.split(".");
    let value;
    if (input.type === "checkbox") value = input.checked;
    // 비운 칸은 null — 데몬이 그 키를 지워 기본값으로 돌린다(undefined 는 JSON 에서 사라진다)
    else if (input.type === "number") value = input.value === "" ? null : Number(input.value);
    else if (path[0] === "allowedLogins") value = input.value.split(",").map((part) => part.trim()).filter((part) => part !== "");
    else value = input.value === "" ? null : input.value;
    if (path.length === 2) void save({ [path[0]]: { ...settings[path[0]], [path[1]]: value } });
    else void save({ [path[0]]: value });
  });
}

const actions = {
  "install-tailscale": () => bridge.openExternal("https://tailscale.com/download/mac"),
  "open-dns": () => bridge.openExternal("https://login.tailscale.com/admin/dns"),
  "register-serve": async (button) => {
    const output = button.closest(".step-body").querySelector(".output");
    output.hidden = false;
    output.textContent = "등록하는 중…";
    try {
      const result = await bridge.registerServe();
      output.textContent = result.output || (result.ok ? "등록했습니다." : "등록하지 못했습니다.");
    } catch (error) {
      output.textContent = errorText(error);
    }
    await refresh();
  },
  "copy-url": () => current.status?.pwaUrl && bridge.copy(current.status.pwaUrl),
  "test-push": async (button) => {
    try {
      const result = await bridge.testPush();
      button.textContent = result.sent > 0 ? `${result.sent}대에 보냈습니다` : "보낼 기기가 없습니다";
    } catch (error) {
      button.textContent = errorText(error);
    }
    setTimeout(() => { button.textContent = button.dataset.label; }, 4000);
    await refresh();
  },
  finish: async () => {
    await bridge.onboarded();
    show("settings");
  },
  restart: () => bridge.restartDaemon(),
  logs: () => bridge.openLogs(),
  refresh: async () => {
    await bridge.refreshNetwork().catch(() => undefined);
    await refresh();
  },
  "add-folder": async () => {
    const chosen = await bridge.chooseFolders();
    if (chosen.length > 0) await save({ projectFolders: [...new Set([...settings.projectFolders, ...chosen])] });
  },
};

for (const button of $$("[data-action]")) {
  button.dataset.label = button.textContent;
  button.addEventListener("click", () => void actions[button.dataset.action]?.(button));
}

// 화면 고르기 — 탭 하나만 Tab 으로 닿고 화살표·Home·End 로 옮긴다
for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.view));
$(".segmented").addEventListener("keydown", (event) => {
  const index = tabs.indexOf(document.activeElement);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (index < 0 || next === undefined) return;
  event.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  tab.focus();
  show(tab.dataset.view);
});

// 본문이 머리 밑으로 들어가면 머리에 선을 켠다
scroller.addEventListener("scroll", () => {
  $(".toolbar").dataset.edge = String(scroller.scrollTop > 0);
}, { passive: true });

// 시스템 테마가 바뀌면 색 전환이 한꺼번에 돌아 화면이 번진다 — 바뀌는 순간만 전환을 끄고 다음 틀에서 돌려놓는다.
// CSP 가 인라인 style 을 막아 PWA 처럼 style 요소를 넣지 않고 style.css 의 클래스를 켠다
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  document.documentElement.classList.add("theme-switching");
  void document.body.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("theme-switching")));
});

async function refresh() {
  current = await bridge.status();
  await render();
}

/**
 * 관리 콘솔·폰처럼 바깥에서 바꾼 것을 바로 잡는다 — 데몬은 Tailscale 을 60초마다만 다시 재서(daemon/src/main.ts)
 * 창으로 돌아오면 곧장, 시작하기를 보는 동안 Tailscale 단계가 남아 있으면 3초마다 다시 재게 한다
 */
let probing = false;
async function probeNetwork() {
  if (probing) return;
  probing = true;
  try {
    await bridge.refreshNetwork();
  } catch {
    // 데몬이 닿지 않으면 상태 띠가 까닭을 보인다
  } finally {
    probing = false;
  }
  await refresh();
}

function networkStepsDone() {
  const tailscale = current.status?.tailscale;
  const serve = current.status?.serve;
  return tailscale?.loggedIn === true && tailscale.httpsEnabled && serve?.configured === true && serve.funnel !== true
    && (tailscale.phones ?? []).some((phone) => phone.online);
}

window.addEventListener("focus", () => void probeNetwork());
setInterval(() => {
  if (document.hidden || $("#view-onboarding").hidden || networkStepsDone()) return;
  void probeNetwork();
}, 3_000);

bridge.onStatus((value) => {
  current = value;
  void render();
});
bridge.onView((view) => show(view));

show(location.hash === "#settings" ? "settings" : "onboarding");
void refresh();
bridge.settings().then((value) => {
  settings = value;
  renderSettings();
}).catch(() => undefined);
