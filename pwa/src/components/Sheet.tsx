/**
 * 아래에서 올라오는 시트 — 아이폰에서 엄지가 닿는 자리. 넓은 화면에서는 가운데 대화상자다.
 * 네이티브 `<dialog>` 의 `showModal()` 로 띄워 뒤쪽은 inert 가 되고 Esc 가 닫는다. 닫으면 연 단추로 초점을 돌린다.
 * 높이는 키보드가 올라온 실제 높이(--app-height)를 따라 입력칸이 키보드에 가리지 않는다.
 * 안쪽 단추가 시트를 닫을 때는 `useSheetClose()` 를 불러 나가는 움직임을 그린 뒤 내린다
 */
import { Check, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usedKeyboardLast } from "../hooks.ts";
import { Icon } from "./icons.tsx";

const EXIT_MS = 200;
const SheetClose = createContext<() => void>(() => undefined);

export function useSheetClose(): () => void {
  return useContext(SheetClose);
}

export function Sheet({ title, onClose, children, actions }: {
  title: string; onClose: () => void; children: ReactNode; actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [trigger] = useState(() => document.activeElement);
  const [state, setState] = useState<"opening" | "open" | "closing">("opening");
  const titleId = useId();
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setState("closing");
    setTimeout(onClose, EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    // 처음 초점 — 표시한 칸(덜 위험한 단추·입력칸)이나 본문의 첫 단추. 손가락으로 열었으면 판에 두어 고리가 켜지지 않게 한다
    const marked = dialog.querySelector<HTMLElement>("[data-autofocus]");
    const first = marked?.tagName === "INPUT" || usedKeyboardLast()
      ? marked ?? dialog.querySelector<HTMLElement>(".sheet-body :is(button, input, textarea, select, a[href])")
      : dialog.querySelector<HTMLElement>(".sheet-panel");
    first?.focus({ preventScroll: true });
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setState("open"));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      if (dialog.open) dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return (
    <dialog
      ref={ref} className="sheet" data-state={state} aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        // 시트 바깥의 어두운 자리를 누르면 닫는다
        if (event.target === event.currentTarget) close();
      }}
    >
      <SheetClose.Provider value={close}>
        <div className="sheet-panel" tabIndex={-1}>
          <div className="sheet-grabber" aria-hidden="true" />
          <header className="sheet-head">
            <h2 id={titleId} className="sheet-title">{title}</h2>
            <button type="button" className="icon-btn tinted sheet-close" onClick={close} aria-label="닫기"><Icon icon={X} /></button>
          </header>
          <div className="sheet-body">{children}</div>
          {actions !== undefined ? <div className="sheet-actions">{actions}</div> : null}
        </div>
      </SheetClose.Provider>
    </dialog>
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
  detail?: string;
  icon?: Parameters<typeof Icon>[0]["icon"];
}

/** `footer` 는 목록 아래 칸 — 고르지 않고 켜고 끄는 것(빠른 모드 등)을 둔다 */
export function ChoiceSheet({ title, options, value, onChoose, onClose, note, footer }: {
  title: string; options: ChoiceOption[]; value: string | undefined; onChoose: (value: string) => void; onClose: () => void; note?: string; footer?: ReactNode;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      {note !== undefined ? <p className="sheet-note">{note}</p> : null}
      <ChoiceRows options={options} value={value} onChoose={onChoose} />
      {footer}
    </Sheet>
  );
}

/** 고른 것은 체크 표시와 `aria-current` 로 알린다 — 누르면 고르고 바로 닫는 목록이라 라디오가 아니다 */
function ChoiceRows({ options, value, onChoose }: { options: ChoiceOption[]; value: string | undefined; onChoose: (value: string) => void }) {
  const close = useSheetClose();
  return (
    <div className="group">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value} type="button" className={`group-row ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined}
            data-autofocus={selected ? "" : undefined}
            onClick={() => {
              onChoose(option.value);
              close();
            }}
          >
            {option.icon !== undefined ? <span className="row-tile"><Icon icon={option.icon} /></span> : null}
            <span className="row-text">
              <span className="row-title">{option.label}</span>
              {option.detail !== undefined ? <span className="row-sub">{option.detail}</span> : null}
            </span>
            <span className="row-trail">{selected ? <Icon icon={Check} className="bold check" /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 되돌릴 수 없는 일을 하기 전에 묻는다 — 제목이 동작과 대상을 말하고 단추는 동사다.
 * 덜 위험한 쪽(취소)에 초점을 둔다
 */
export function ConfirmSheet({ title, body, confirmLabel, onConfirm, onClose, tone = "primary" }: {
  title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; tone?: "primary" | "danger";
}) {
  return (
    <Sheet title={title} onClose={onClose} actions={<ConfirmActions confirmLabel={confirmLabel} onConfirm={onConfirm} tone={tone} />}>
      <div className="sheet-prose">{body}</div>
    </Sheet>
  );
}

function ConfirmActions({ confirmLabel, onConfirm, tone }: { confirmLabel: string; onConfirm: () => void; tone: "primary" | "danger" }) {
  const close = useSheetClose();
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={close} data-autofocus="">취소</button>
      <button type="button" className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`} onClick={() => {
        onConfirm();
        close();
      }}>{confirmLabel}</button>
    </>
  );
}
