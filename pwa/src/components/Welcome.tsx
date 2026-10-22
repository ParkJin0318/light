/**
 * 첫 진입 안내 — Safari 로 열면 홈 화면에 추가하는 법을, 홈 화면 앱을 처음 열면 알림 켜기와 테스트 알림을 시트로 띄운다.
 * iOS 는 홈 화면 앱에서만 웹 푸시를 받는다. 설치 안내는 Safari 로 열 때마다, 알림 안내는 한 번만 뜬다(닫아도 설정 화면에 남는다)
 */
import { BellRing, Menu, Send, Smartphone, SquarePlus, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { usePushSetup } from "../hooks.ts";
import { isStandalone, pushSupport } from "../push.ts";
import { useAppState } from "../store.ts";
import { Icon } from "./icons.tsx";
import { Sheet, useSheetClose } from "./Sheet.tsx";

/** 이 탭에서 설치 안내를 닫았다 — 다음에 Safari 로 열면 다시 뜬다 */
const INSTALL_DISMISSED = "light.installGuideDismissed";
/** 알림 안내를 한 번 보였다 */
const PUSH_PROMPTED = "light.pushPrompted";

function flagged(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) !== null;
  } catch {
    return false;
  }
}

function flag(storage: () => Storage, key: string): void {
  try {
    storage().setItem(key, "1");
  } catch {
    // 저장소를 못 쓰는 창 — 이번만 닫는다
  }
}

export function Welcome() {
  const [guide, setGuide] = useState<"install" | "push" | undefined>(() => {
    const support = pushSupport();
    if (support === "needsInstall" && !flagged(() => sessionStorage, INSTALL_DISMISSED)) return "install";
    if (isStandalone() && support === "default" && !flagged(() => localStorage, PUSH_PROMPTED)) return "push";
    return undefined;
  });
  if (guide === "install") {
    return <InstallSheet onClose={() => {
      flag(() => sessionStorage, INSTALL_DISMISSED);
      setGuide(undefined);
    }} />;
  }
  if (guide === "push") {
    return <PushSheet onClose={() => {
      flag(() => localStorage, PUSH_PROMPTED);
      setGuide(undefined);
    }} />;
  }
  return null;
}

const INSTALL_STEPS: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: Menu, title: "아래 막대의 ≡ → 공유", detail: "iPad 와 iOS 18 이하는 공유 단추를 바로 누릅니다." },
  { icon: SquarePlus, title: "홈 화면에 추가 → 추가", detail: "목록에 없으면 아래로 내려 찾습니다." },
  { icon: Smartphone, title: "홈 화면의 light 로 열기", detail: "처음 열면 알림을 켜는 안내가 이어집니다." },
];

function InstallSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="홈 화면에 추가하십시오" onClose={onClose} actions={<CloseAction label="Safari 에서 계속 보기" />}>
      <p className="sheet-note">승인 알림과 전체 화면은 홈 화면에 추가한 light 에서만 됩니다. iOS·iPadOS 16.4 이상이 필요합니다.</p>
      <ol className="group guide-steps">
        {INSTALL_STEPS.map((step, index) => (
          <li key={step.title} className="group-row static">
            <span className="row-tile"><Icon icon={step.icon} /></span>
            <span className="row-text">
              <span className="row-title"><span className="guide-index">{index + 1}.</span>{step.title}</span>
              <span className="row-sub wrap">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

function PushSheet({ onClose }: { onClose: () => void }) {
  const { support, busy, failure, ready, enable, test } = usePushSetup();
  const connected = useAppState((state) => state.connection === "connected");
  const granted = support === "granted" && failure === undefined;
  const body = granted ? "이제 승인 요청·질문·턴 완료·오류가 이 기기로 옵니다. 테스트 알림으로 도착을 확인하십시오."
    : support === "denied" ? "알림을 거절했습니다. 설정 앱 → 알림 → light 에서 켜면 받습니다."
    : "승인 요청과 질문이 잠금 화면으로 와서 폰을 내려놓아도 세션이 멈춰 있지 않습니다. 지금 보고 있는 세션의 알림은 오지 않습니다.";
  const actions = granted ? (
    <>
      <CloseAction label="닫기" />
      <button type="button" className="btn btn-primary has-leading-icon" aria-disabled={busy || !connected || undefined} onClick={() => {
        if (connected) test();
      }}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon icon={Send} />}테스트 알림 보내기
      </button>
    </>
  ) : support === "default" || failure !== undefined ? (
    <>
      <CloseAction label="나중에" />
      <button type="button" className="btn btn-primary has-leading-icon" aria-disabled={busy || !ready || undefined} onClick={enable}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon icon={BellRing} />}{busy ? "켜는 중…" : failure !== undefined ? "다시 켜기" : "알림 켜기"}
      </button>
    </>
  ) : <CloseAction label="닫기" />;
  return (
    <Sheet title={granted ? "알림이 켜졌습니다" : "알림을 켜십시오"} onClose={onClose} actions={actions}>
      <div className="sheet-prose"><p>{body}</p></div>
      {failure !== undefined ? <p className="field-error" role="alert">알림을 켜지 못했습니다 — {failure}. 「다시 켜기」를 누르고, 그래도 안 되면 앱을 닫았다 다시 여십시오.</p> : null}
    </Sheet>
  );
}

function CloseAction({ label }: { label: string }) {
  const close = useSheetClose();
  return <button type="button" className="btn btn-secondary" onClick={close} data-autofocus="">{label}</button>;
}
