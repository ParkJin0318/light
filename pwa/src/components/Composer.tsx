/**
 * 입력창 — 도크 맨 아래 카드 한 장이고 키보드 위에 붙는다. 카드 안 아래 줄에 첨부·권한 모드·모델·보내기를 둔다.
 * 한글 조합 중의 Enter 는 보내지 않는다. 보낸 글은 데몬이 받았다고 답할 때까지 입력창에 남고, 실패하면 재전송을 준다.
 * 턴이 도는 중에 보낸 글은 대기열에 쌓이고 턴이 끝나면 하나로 합쳐 간다 — 쌓인 글은 취소하거나 지금 끼워 넣는다.
 * 답에서 고른 글은 인용으로 쌓였다가 다음 메시지에 붙는다. light 가 대신 처리하는 명령(`/btw`·`/fork`·`/background`·`!`)도 자동 완성에 낸다
 */
import { ArrowUp, Camera, CircleAlert, Clock, Cpu, FileText, Gauge, Image as ImageIcon, Paperclip, Quote, RotateCw, X, Zap } from "lucide-react";
import {
  useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject,
} from "react";
import type { AttachedSnippet } from "../../../shared/src/session/attachments.ts";
import { NATIVE_SLASH_COMMANDS } from "../../../shared/src/session/commands.ts";
import type { QueuedMessage } from "../../../shared/src/session/conversation.ts";
import { imageName, prepareImage, startUpload, type Attachment } from "../attachments.ts";
import { connection } from "../connection.ts";
import { PERMISSION_MODE_DETAILS, effortLabel, permissionModeLabel, usedKeyboardLast } from "../hooks.ts";
import { clearQuotes, removeQuote, takeDraft, toast, useAppState } from "../store.ts";
import { Icon, modeIcon } from "./icons.tsx";
import type { ChoiceOption } from "./Sheet.tsx";

/** SDK 세션에서 안 되는 명령 — 보내면 「isn't available in this environment」로 끝난다(실측) */
const UNAVAILABLE_COMMANDS = new Set(["help", "status", "memory", "permissions", "hooks", "plugin", "export", "add-dir", "login", "logout", "config", "resume", "plan", "fast", "statusline", "terminal-setup", "vim", "theme", "ide", "exit", "quit"]);

export function useAttachments(limits: { imagesPerMessage: number; filesPerMessage: number; fileBytes: number } | undefined) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const update = (key: string) => (change: Partial<Attachment>) =>
    setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, ...change } : attachment)));

  const addFiles = async (files: FileList | File[], kind: "image" | "file") => {
    for (const file of Array.from(files)) {
      const count = attachments.filter((attachment) => attachment.kind === kind).length;
      const max = kind === "image" ? limits?.imagesPerMessage ?? 20 : limits?.filesPerMessage ?? 20;
      if (count >= max) {
        toast(kind === "image" ? `이미지는 한 메시지에 ${max}장까지입니다. 나머지는 다음 메시지에 붙이십시오.` : `파일은 한 메시지에 ${max}개까지입니다. 나머지는 다음 메시지에 붙이십시오.`, { tone: "error" });
        return;
      }
      if (kind === "file" && file.size > (limits?.fileBytes ?? 20 * 1024 * 1024)) {
        toast(`${file.name} 은 20MB 를 넘어 붙이지 못합니다. 더 작게 나눠 붙이십시오.`, { tone: "error" });
        continue;
      }
      const key = crypto.randomUUID();
      const treatAsImage = kind === "image" || (file.type.startsWith("image/") && file.type !== "image/svg+xml");
      const attachment: Attachment = {
        key, kind: treatAsImage ? "image" : "file", name: treatAsImage ? imageName(file) : file.name, progress: 0, status: "preparing",
        ...(treatAsImage ? { previewURL: URL.createObjectURL(file) } : {}),
      };
      setAttachments((current) => [...current, attachment]);
      try {
        const blob = treatAsImage ? await prepareImage(file) : file;
        const ready = { ...attachment, blob };
        update(key)({ blob });
        await startUpload(ready, update(key));
      } catch (error) {
        update(key)({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const retry = (key: string) => {
    const attachment = attachments.find((candidate) => candidate.key === key);
    if (attachment !== undefined) void startUpload(attachment, update(key));
  };
  const remove = (key: string) => setAttachments((current) => current.filter((attachment) => attachment.key !== key));
  const clear = () => setAttachments([]);
  const ready = attachments.every((attachment) => attachment.status === "done");
  const ids = attachments.flatMap((attachment) => (attachment.info === undefined ? [] : [attachment.info.id]));
  return { attachments, addFiles, retry, remove, clear, ready, ids };
}

type AttachmentState = ReturnType<typeof useAttachments>;

function AttachmentStrip({ state }: { state: AttachmentState }) {
  if (state.attachments.length === 0) return null;
  return (
    <div className="attachment-strip" role="group" aria-label="붙인 것">
      {state.attachments.map((attachment) => {
        const busy = attachment.status === "uploading" || attachment.status === "preparing";
        return (
          <div key={attachment.key} className={`attachment ${attachment.status} ${attachment.previewURL !== undefined ? "image" : "file"}`}>
            {attachment.previewURL !== undefined ? <img src={attachment.previewURL} alt={attachment.name} /> : (
              <span className="attachment-file"><Icon icon={FileText} /><span className="attachment-name">{attachment.name}</span></span>
            )}
            {busy ? (
              <span className="attachment-progress" role="progressbar" aria-label={`${attachment.name} 올리는 중`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(attachment.progress * 100)}>
                <span style={{ width: `${Math.max(6, attachment.progress * 100)}%` }} />
              </span>
            ) : null}
            {attachment.status === "failed" ? (
              <button type="button" className="attachment-retry" onClick={() => state.retry(attachment.key)} aria-label={`${attachment.name} 다시 올리기`}>
                <Icon icon={RotateCw} className="bold" /><span>다시</span>
              </button>
            ) : null}
            <button type="button" className="attachment-remove" onClick={() => state.remove(attachment.key)} aria-label={`${attachment.name} 빼기`}><Icon icon={X} className="bold" /></button>
          </div>
        );
      })}
    </div>
  );
}

/** 첨부 단추 — 사진 보관함·카메라·파일 세 갈래를 여는 펼침 목록. Esc·바깥 누르기로 닫고 단추로 초점을 돌린다 */
function AttachButton({ state }: { state: AttachmentState }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    if (usedKeyboardLast()) menu.current?.querySelector("button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (input: HTMLInputElement | null) => {
    input?.click();
    setOpen(false);
  };
  const picked = (kind: "image" | "file") => (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void state.addFiles(event.target.files, kind);
    event.target.value = "";
  };
  return (
    <div className="attach">
      <button ref={button} type="button" className="icon-btn composer-tool" onClick={() => setOpen(!open)} aria-label="첨부" aria-expanded={open} aria-controls={menuId}>
        <Icon icon={Paperclip} />
      </button>
      <div ref={menu} id={menuId} className="popover attach-menu" hidden={!open}>
        <button type="button" onClick={() => pick(photo.current)}><Icon icon={ImageIcon} />사진 보관함</button>
        <button type="button" onClick={() => pick(camera.current)}><Icon icon={Camera} />카메라</button>
        <button type="button" onClick={() => pick(file.current)}><Icon icon={FileText} />파일</button>
      </div>
      <input ref={photo} type="file" accept="image/*" multiple hidden onChange={picked("image")} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={picked("image")} />
      <input ref={file} type="file" multiple hidden onChange={picked("file")} />
    </div>
  );
}

/** 다음 메시지에 붙을 인용 — 한 줄로 줄여 보이고 하나씩 뺀다 */
function QuoteStrip({ sessionId, quotes }: { sessionId: string; quotes: AttachedSnippet[] }) {
  if (quotes.length === 0) return null;
  return (
    <div className="quote-strip" role="group" aria-label="붙인 인용">
      {quotes.map((quote, index) => (
        <div key={index} className="quote-chip">
          <Icon icon={Quote} className="small" />
          <span className="quote-text">{quote.text.replace(/\s+/g, " ")}</span>
          <button type="button" className="attachment-remove" onClick={() => removeQuote(sessionId, index)} aria-label="인용 빼기"><Icon icon={X} className="bold" /></button>
        </div>
      ))}
    </div>
  );
}

/** 넓은 화면·하드웨어 키보드에서는 Enter 가 보내기, 터치 키보드에서는 줄 바꿈이다. ⌘↩ 는 늘 보내기 */
export function shouldSend(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey) return true;
  if (event.shiftKey || event.altKey) return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** 글칸 높이를 글에 맞춘다 — 위로는 CSS 의 max-height 까지 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [ref, value]);
}

/** 입력 카드 틀 — 대화와 새 세션이 같이 쓴다. 아래 줄 왼쪽은 첨부와 `toolbar`, 오른쪽 끝은 `action` */
export function ComposerCard({ attachments, children, toolbar, action, quotes }: { attachments: AttachmentState; children: ReactNode; toolbar?: ReactNode; action: ReactNode; quotes?: ReactNode }) {
  return (
    <div className="composer">
      {quotes}
      <AttachmentStrip state={attachments} />
      {children}
      <div className="composer-bar">
        <AttachButton state={attachments} />
        <div className="composer-toolbar">{toolbar}</div>
        {action}
      </div>
    </div>
  );
}

/**
 * 입력 카드 아래 줄의 권한 모드·모델·노력도 칩 — 누르면 고르는 시트를 연다. `verb` 는 낭독기가 읽는 동작(바꾸기·고르기).
 * 노력도 칩은 `onEffort` 가 있을 때만 — 노력도를 받지 않는 모델(Haiku 4.5)이면 화면이 빼고 넘긴다. 빠른 모드를 켰으면 모델 칩이 번개다
 */
export function ModeModelChips({ mode, model, effort, fast, verb, onMode, onModel, onEffort }: {
  mode: string; model: string; effort?: string; fast?: boolean; verb: string; onMode: () => void; onModel: () => void; onEffort?: () => void;
}) {
  const modeName = permissionModeLabel(mode);
  const effortName = effortLabel(effort);
  return (
    <>
      <button type="button" className="chip" onClick={onMode} aria-label={`권한 모드: ${modeName}. ${verb}`}>
        <Icon icon={modeIcon(mode)} /><span className="chip-label">{modeName}</span>
      </button>
      <button type="button" className="chip" onClick={onModel} aria-label={`모델: ${model}${fast === true ? ", 빠른 모드" : ""}. ${verb}`}>
        {fast === true ? <Icon icon={Zap} className="keep" /> : <Icon icon={Cpu} />}<span className="chip-label">{model}</span>
      </button>
      {onEffort !== undefined ? (
        <button type="button" className="chip effort" onClick={onEffort} aria-label={`노력도: ${effortName}. ${verb}`}>
          <Icon icon={Gauge} /><span className="chip-label">{effortName}</span>
        </button>
      ) : null}
    </>
  );
}

/** 노력도 시트의 선택지 — 그 모델이 받는 단계만. 빈 값은 claude 설정과 모델 기본값 */
export function effortOptions(efforts: readonly string[]): ChoiceOption[] {
  return [
    { value: "", label: effortLabel(undefined), detail: "claude 설정과 모델이 정한 값을 씁니다", icon: Gauge },
    ...efforts.map((level) => ({
      value: level, label: effortLabel(level), icon: Gauge,
      ...(level === "max" ? { detail: "최대를 받지 않는 모델에서는 높음으로 돕니다" } : {}),
    })),
  ];
}

/** 권한 모드 시트의 선택지 — 터미널의 shift+tab 순서 */
export function permissionModeOptions(): ChoiceOption[] {
  return ["default", "acceptEdits", "plan", "bypassPermissions"].map((mode) => ({
    value: mode, label: permissionModeLabel(mode), icon: modeIcon(mode),
    ...(PERMISSION_MODE_DETAILS[mode] !== undefined ? { detail: PERMISSION_MODE_DETAILS[mode] } : {}),
  }));
}

/** 보내기 — 보내는 동안 화살표가 고리로 바뀐다(두 그림을 겹쳐 두고 CSS 가 바꾼다) */
function SendButton({ busy, disabled, label, onClick }: { busy: boolean; disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className="send-button" data-busy={busy} disabled={disabled} aria-disabled={busy || undefined} onClick={busy ? undefined : onClick} aria-label={label}>
      <span className="swap">
        <span className="swap-layer is-idle"><Icon icon={ArrowUp} /></span>
        <span className="swap-layer is-busy"><span className="spinner" /></span>
      </span>
    </button>
  );
}

const NO_QUOTES: AttachedSnippet[] = [];

export function Composer({ sessionId, isTurnActive, queued, suggestion, slashCommands, status, toolbar }: {
  sessionId: string; isTurnActive: boolean; queued: QueuedMessage[]; suggestion?: string; slashCommands: string[]; status?: ReactNode; toolbar?: ReactNode;
}) {
  const config = useAppState((state) => state.config);
  const outbox = useAppState((state) => state.outbox);
  const quotes = useAppState((state) => state.quotes[sessionId]) ?? NO_QUOTES;
  const draft = useAppState((state) => state.drafts[sessionId]);
  const [text, setText] = useState("");
  const [pendingId, setPendingId] = useState<string | undefined>(undefined);
  const attachments = useAttachments(config?.limits);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const outgoing = pendingId === undefined ? undefined : outbox[pendingId];
  useAutosize(textarea, text);

  // 되감은 메시지가 돌아왔다 — 입력창에 넣고 고쳐 보내게 한다
  useEffect(() => {
    if (draft === undefined) return;
    const taken = takeDraft(sessionId);
    if (taken === undefined) return;
    setText(taken);
    textarea.current?.focus();
  }, [draft, sessionId]);

  // 데몬이 받았다고 답하면 비운다 — 실패하면 글은 그대로 남는다
  useEffect(() => {
    if (pendingId !== undefined && outgoing === undefined) {
      setText("");
      attachments.clear();
      clearQuotes(sessionId);
      setPendingId(undefined);
    }
  }, [pendingId, outgoing]); // eslint-disable-line react-hooks/exhaustive-deps

  const sending = outgoing?.status === "sending";
  const canSend = (text.trim() !== "" || attachments.ids.length > 0 || quotes.length > 0) && attachments.ready && !sending;

  const send = (mode: "queue" | "now" = "queue") => {
    if (!canSend) return;
    // 같은 글을 다시 보내면 같은 id 로 — 데몬이 이미 받았으면 두 번 보내지 않는다
    const same = outgoing !== undefined && outgoing.text === text && outgoing.attachments.join() === attachments.ids.join()
      && JSON.stringify(outgoing.snippets) === JSON.stringify(quotes);
    const retry = same ? pendingId : undefined;
    if (pendingId !== undefined && retry === undefined) connection.discardOutgoing(pendingId);
    setPendingId(connection.sendMessage(sessionId, text, attachments.ids, mode, retry, quotes));
    if (/^\/btw\s+\S/.test(text.trim()) && attachments.ids.length === 0 && quotes.length === 0) toast("곁가지 질문을 보냈습니다. 답은 대화에 안내 줄로 뜹니다.");
  };

  const commands = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ") || text.includes("\n")) return [];
    const needle = text.slice(1).toLowerCase();
    const all = [...new Set([...NATIVE_SLASH_COMMANDS, ...slashCommands])];
    return all.filter((command) => !UNAVAILABLE_COMMANDS.has(command) && command.toLowerCase().startsWith(needle)).slice(0, 8);
  }, [text, slashCommands]);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void attachments.addFiles(images, "image");
  };

  return (
    <div className="composer-stack">
      {queued.length > 0 ? (
        <ul className="queue" aria-label="대기 중인 메시지">
          {queued.map((message) => (
            <li key={message.id} className="queued">
              <Icon icon={Clock} className="small" />
              <span className="queued-text">{message.text || `첨부 ${message.attachments.length}개`}</span>
              <button type="button" className="btn btn-ghost small" onClick={() => connection.send({ type: "queueSendNow", sessionId, queueId: message.id })}>지금 끼워 넣기</button>
              <button type="button" className="icon-btn small" onClick={() => connection.send({ type: "queueCancel", sessionId, queueId: message.id })} aria-label="대기 취소"><Icon icon={X} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {outgoing?.status === "failed" ? (
        <div className="callout danger send-failed" role="alert">
          <Icon icon={CircleAlert} />
          <span className="callout-text">{outgoing.error ?? "보내지 못했습니다. 연결을 확인하고 다시 보내십시오."}</span>
          <button type="button" className="btn btn-secondary small" onClick={() => send()}>재전송</button>
        </div>
      ) : null}
      {commands.length > 0 ? (
        <div className="commands" aria-label="슬래시 명령">
          {commands.map((command) => (
            <button key={command} type="button" className="chip" onClick={() => {
              setText(`/${command} `);
              textarea.current?.focus();
            }}>/{command}</button>
          ))}
        </div>
      ) : suggestion !== undefined && text === "" && !isTurnActive ? (
        <button type="button" className="chip suggestion" onClick={() => {
          setText(suggestion);
          textarea.current?.focus();
        }}><span className="chip-label">{suggestion}</span></button>
      ) : null}
      {status}
      <ComposerCard
        attachments={attachments} toolbar={toolbar} quotes={<QuoteStrip sessionId={sessionId} quotes={quotes} />}
        action={<SendButton busy={sending} disabled={!canSend && !sending} label={isTurnActive ? "대기열에 보내기" : "보내기"} onClick={() => send()} />}
      >
        <textarea
          ref={textarea} className="composer-input" value={text} rows={1} readOnly={sending}
          placeholder={isTurnActive ? "턴이 끝나면 보낼 말" : "Claude 에게 보내기"}
          aria-label="메시지" enterKeyHint="send"
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (shouldSend(event)) {
              event.preventDefault();
              send();
            }
          }}
        />
      </ComposerCard>
    </div>
  );
}
