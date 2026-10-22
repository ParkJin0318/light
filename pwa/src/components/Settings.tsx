/**
 * 이 기기의 설정 — 알림 켜기(사용자 동작 뒤에만 권한을 물을 수 있다)와 테스트 푸시. 알림 종류·잠금 화면 감추기는 Mac 앱 설정이다
 */
import { Bell, BellOff, BellRing, Keyboard, Send, Smartphone } from "lucide-react";
import { useRef } from "react";
import { deviceId } from "../api.ts";
import { routeHref, usePushSetup, useScrolledPast } from "../hooks.ts";
import { isStandalone, type PushSupport } from "../push.ts";
import { useAppState } from "../store.ts";
import { Icon } from "./icons.tsx";
import { NavBar } from "./NavBar.tsx";

const SUPPORT: Record<PushSupport, { title: string; detail: string; icon: typeof Bell; tone: string }> = {
  unsupported: { title: "웹 푸시를 받지 못하는 브라우저", detail: "iPhone·iPad 의 Safari 에서 홈 화면에 추가한 light 로 여십시오.", icon: BellOff, tone: "" },
  needsInstall: { title: "홈 화면에 추가해야 알림이 옵니다", detail: "Safari 공유 메뉴의 「홈 화면에 추가」로 설치한 뒤 그 아이콘으로 여십시오(iOS 16.4 이상).", icon: Smartphone, tone: "lamp" },
  default: { title: "알림이 꺼져 있습니다", detail: "켜면 승인 요청이 잠금 화면으로 옵니다.", icon: Bell, tone: "" },
  granted: { title: "알림이 켜져 있습니다", detail: "이 기기로 승인 요청·질문·턴 완료·오류가 옵니다.", icon: BellRing, tone: "run" },
  denied: { title: "알림을 거절했습니다", detail: "설정 앱의 알림에서 light 를 켜면 다시 받습니다.", icon: BellOff, tone: "danger" },
};

/** 권한은 받았지만 구독이 실패한 때 — 「켜져 있습니다」로 보이면 알림이 오지 않는 것을 모른다 */
const UNSUBSCRIBED = { title: "알림이 오지 않습니다", detail: "권한은 있지만 이 기기의 구독이 등록되지 않았습니다.", icon: BellOff, tone: "danger" };

export function Settings({ wide }: { wide: boolean }) {
  const config = useAppState((state) => state.config);
  const pushError = useAppState((state) => state.pushError);
  const { support, busy, failure, ready, enable, test } = usePushSetup();
  const scroll = useRef<HTMLDivElement>(null);
  const collapsed = useScrolledPast(scroll, 36);
  const problem = failure ?? pushError;
  const unsubscribed = support === "granted" && problem !== undefined;
  const status = unsubscribed ? UNSUBSCRIBED : SUPPORT[support];
  const enableLabel = unsubscribed ? "구독 다시 등록" : "알림 켜기";

  return (
    <div className="screen form-screen settings-screen">
      <NavBar title="설정" collapsed={collapsed} edge={collapsed} {...(!wide ? { back: { href: routeHref({ name: "list" }), label: "세션 목록" } } : {})} />
      <div className="form-scroll" ref={scroll}>
        <div className="form-column">
          <div className="hero">
            <h1 className="page-title">설정</h1>
            <p className="hero-sub">이 기기에만 적용됩니다</p>
          </div>

          <section className="section" aria-labelledby="push-head">
            <h2 id="push-head" className="section-head">알림</h2>
            <div className="group">
              <div className="group-row static">
                <span className={`row-tile ${status.tone}`}><Icon icon={status.icon} /></span>
                <span className="row-text">
                  <span className="row-title">{status.title}</span>
                  <span className="row-sub wrap">{status.detail}</span>
                </span>
              </div>
              {(support === "default" || unsubscribed) && ready ? (
                <button type="button" className="group-row action" aria-disabled={busy || undefined} onClick={enable}>
                  <span className="row-tile ink">{busy ? <span className="spinner" aria-hidden="true" /> : <Icon icon={BellRing} />}</span>
                  <span className="row-text"><span className="row-title">{busy ? (unsubscribed ? "등록하는 중…" : "알림을 켜는 중…") : enableLabel}</span></span>
                </button>
              ) : null}
              {support === "granted" && !unsubscribed ? (
                <button type="button" className="group-row action" aria-disabled={busy || undefined} onClick={test}>
                  <span className="row-tile">{busy ? <span className="spinner" aria-hidden="true" /> : <Icon icon={Send} />}</span>
                  <span className="row-text"><span className="row-title">테스트 알림 보내기</span></span>
                </button>
              ) : null}
            </div>
            {problem !== undefined ? <p className="field-error" role="alert">알림을 켜지 못했습니다 — {problem}. {unsubscribed ? "「구독 다시 등록」을" : "「알림 켜기」를"} 누르고, 그래도 안 되면 앱을 닫았다 다시 여십시오.</p> : null}
            <p className="section-foot">종류별 끄기와 잠금 화면 본문 감추기는 Mac 앱 설정에서 고릅니다. 지금 보고 있는 세션의 알림은 이 기기로 오지 않습니다.</p>
          </section>

          <section className="section" aria-labelledby="device-head">
            <h2 id="device-head" className="section-head">이 기기</h2>
            <dl className="group facts">
              <div className="group-row static"><dt>설치</dt><dd>{isStandalone() ? "홈 화면 앱" : "브라우저 탭"}</dd></div>
              <div className="group-row static"><dt>기기 id</dt><dd className="mono">{deviceId().slice(0, 12)}</dd></div>
              <div className="group-row static"><dt>Mac</dt><dd className="mono"><bdi>{location.host}</bdi></dd></div>
              <div className="group-row static"><dt>판</dt><dd className="mono">{config?.version ?? "받는 중"}</dd></div>
            </dl>
          </section>

          <section className="section" aria-labelledby="keys-head">
            <h2 id="keys-head" className="section-head"><Icon icon={Keyboard} className="small" />단축키<span className="count-note">하드웨어 키보드</span></h2>
            <dl className="group facts keys">
              <div className="group-row static"><dt><kbd>⌘</kbd><kbd>↩</kbd></dt><dd>보내기</dd></div>
              <div className="group-row static"><dt><kbd>Esc</kbd></dt><dd>진행 중인 턴 중단</dd></div>
              <div className="group-row static"><dt><kbd>⌘</kbd><kbd>[</kbd> <kbd>⌘</kbd><kbd>]</kbd></dt><dd>앞뒤 세션</dd></div>
              <div className="group-row static"><dt><kbd>⌥</kbd><kbd>N</kbd></dt><dd>새 세션</dd></div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
