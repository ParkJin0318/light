/**
 * 마크다운 — marked 로 그리고 DOMPurify 로 거른다. 모델 글은 남이 쓴 글로 다룬다.
 * 코드 블록은 고정폭 그대로다(문법 강조는 하지 않는다). 거른 뒤에 코드 블록에 언어 이름과 복사 단추를, 표에 가로 스크롤 틀을 씌운다.
 * 링크는 새 창으로
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { memo, useMemo, type MouseEvent } from "react";

const marked = new Marked({ gfm: true, breaks: false, async: false });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// lucide 의 copy·check 그림 — 거른 HTML 에 붙이는 고정 글이라 컴포넌트를 쓰지 않는다
const COPY_ICON = '<svg class="icon copy-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg class="icon check-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function decorate(html: string): string {
  return html
    .replace(/<pre><code(?: class="language-([\w+#.-]+)")?>/g, (_, language: string | undefined) => (
      `<div class="code-block"><div class="code-head"><span class="code-lang">${language ?? ""}</span>`
      + `<button type="button" class="code-copy" aria-label="코드 복사">${COPY_ICON}${CHECK_ICON}</button></div><pre><code${language !== undefined ? ` class="language-${language}"` : ""}>`
    ))
    .replace(/<\/code><\/pre>/g, "</code></pre></div>")
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return decorate(DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "img", "form", "input", "button"], FORBID_ATTR: ["style"] }));
}

/** 코드 복사 — 누르면 그림이 체크로 바뀌었다가 돌아온다(그림 둘을 겹쳐 두고 CSS 가 바꾼다) */
function onCopyClick(event: MouseEvent<HTMLDivElement>): void {
  const button = (event.target as Element).closest<HTMLButtonElement>(".code-copy");
  const code = button?.closest(".code-block")?.querySelector("pre");
  if (button === null || button === undefined || code === null || code === undefined) return;
  void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
    button.dataset.copied = "true";
    button.setAttribute("aria-label", "복사했습니다");
    setTimeout(() => {
      delete button.dataset.copied;
      button.setAttribute("aria-label", "코드 복사");
    }, 1_600);
  }, () => undefined);
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown ${className ?? ""}`} onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
