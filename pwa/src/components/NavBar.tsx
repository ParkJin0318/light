/**
 * 화면 머리 — 본문 위에 떠 있고 본문이 그 밑으로 스크롤된다(반투명 면). 높이는 부모의 --nav-h 로 알린다.
 * 큰 제목 화면(목록·새 세션·설정)은 큰 제목이 머리 밑으로 들어가면 가운데 작은 제목과 아래 선을 켠다(iOS 막대와 같다)
 */
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useHeightVar } from "../hooks.ts";
import { Icon } from "./icons.tsx";

export function NavBar({ title, subtitle, back, trailing, collapsed, edge, align = "center", heading = false, children, onHeight }: {
  title: ReactNode;
  /** 머리 제목이 이 화면의 h1 인가 — 큰 제목 화면은 본문의 큰 제목이 h1 이다 */
  heading?: boolean;
  subtitle?: ReactNode;
  /** 뒤로 갈 주소 — 넓은 화면의 오른쪽 칸처럼 뒤가 없으면 비운다 */
  back?: { href: string; label: string };
  trailing?: ReactNode;
  /** 큰 제목 화면에서 큰 제목이 가려졌는가. 없으면 작은 제목을 늘 보인다 */
  collapsed?: boolean;
  /** 본문이 머리 밑으로 들어갔는가 — 아래 선과 면을 켠다 */
  edge: boolean;
  align?: "center" | "start";
  children?: ReactNode;
  onHeight?: (height: number, previous: number) => void;
}) {
  const ref = useHeightVar("--nav-h", onHeight);
  return (
    <header ref={ref} className={`navbar chrome align-${align}`} data-edge={edge} data-collapsed={collapsed ?? true}>
      <div className="navbar-row">
        <div className="navbar-lead">
          {back !== undefined ? <a className="icon-btn navbar-back" href={back.href} aria-label={back.label}><Icon icon={ChevronLeft} /></a> : null}
        </div>
        <div className="navbar-center" aria-hidden={collapsed === false ? true : undefined}>
          {heading ? <h1 className="navbar-title">{title}</h1> : <div className="navbar-title">{title}</div>}
          {subtitle !== undefined ? <div className="navbar-subtitle">{subtitle}</div> : null}
        </div>
        <div className="navbar-trail">{trailing}</div>
      </div>
      {children}
    </header>
  );
}
