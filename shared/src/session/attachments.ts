/**
 * 사람 턴에 붙는 파일·인용 — 데스크톱 앱 Code 탭과 같은 모양으로 글에 싣는다.
 *
 * - 파일: 데몬이 받아 둔 파일을 글머리 한 줄에 `@"절대경로"` 로 빈칸을 두고 잇는다. CLI 의 @멘션은 작업 폴더 밖의 파일도 읽는다(실측)
 * - 인용: `<!-- attach: 이름 -->` 다음 줄부터 `> ` 인용 줄이다 — 대화의 답 일부를 맥락으로 붙인다
 *
 * 보낼 때 데몬이 짓고(`composeAttachments`), 대화에 그릴 때 리듀서가 글머리에서 뗀다(`splitAttachments`) — 지금 보낸 턴과
 * 기록에서 다시 읽은 턴이 같은 길로 칩이 된다. 예전 light 의 모양(경로마다 한 줄, 따옴표는 이스케이프)도 읽는다
 */

/** 맥락으로 붙인 인용 — 대화의 메시지나 그 일부 */
export interface AttachedSnippet {
  /** 인용의 출처 이름(「Claude 의 답」) */
  label?: string;
  text: string;
}

export interface SplitAttachments {
  text: string;
  files: string[];
  snippets: AttachedSnippet[];
}

const LINE_BREAKS = /\r\n?|[\n\u2028\u2029]/g;

/** `@"경로"` 하나 — 따옴표는 빼고 끝의 구분자는 뗀다(데스크톱 앱과 같다) */
export function fileMention(path: string): string {
  return `@"${path.replaceAll("\"", "").replace(/[/\\]+$/, "")}"`;
}

/** 인용 블록 하나 — 이름에 줄바꿈·`-->`·`|` 가 있으면 지운다 */
export function snippetBlock(snippet: AttachedSnippet): string {
  let label = snippet.label?.replace(LINE_BREAKS, " ");
  while (label !== undefined && /-->|\|/.test(label)) label = label.replace(/-->|\|/g, "");
  label = label?.trim();
  const head = label === undefined || label === "" ? "<!-- attach -->" : `<!-- attach: ${label} -->`;
  return `${head}\n${snippet.text.split(LINE_BREAKS).map((line) => `> ${line}`).join("\n")}`;
}

/** 보낼 글 — 파일 멘션 한 줄, 인용 블록들, 본문 순이다 */
export function composeAttachments(text: string, files: readonly string[], snippets: readonly AttachedSnippet[] = []): string {
  const head = files.length > 0 ? `${files.map(fileMention).join(" ")}\n` : "";
  const quotes = snippets.map(snippetBlock).join("\n\n");
  if (quotes === "") return files.length > 0 && text === "" ? head.trimEnd() : `${head}${text}`;
  return text === "" ? `${head}${quotes}` : `${head}${quotes}\n\n${text}`;
}

/** 멘션 하나 — 빈칸·줄바꿈으로 잇는다. 예전 모양의 `\"`·`\\` 이스케이프도 푼다 */
const MENTION = /^@"((?:[^"\\\n]|\\.)+)"(?:[ \n]+|$)/;
const SNIPPET = /^<!-- attach(?:: (.*?))?(?: \| tab:\S+)? -->\r?\n((?:>[^\n]*(?:\n|$))+)/;

/** 글머리의 멘션·인용을 뗀다 — 없으면 글 그대로에 빈 목록 */
export function splitAttachments(text: string): SplitAttachments {
  let rest = text;
  const files: string[] = [];
  for (let match = MENTION.exec(rest); match !== null; match = MENTION.exec(rest)) {
    files.push(match[1]!.replace(/\\(["\\])/g, "$1"));
    rest = rest.slice(match[0].length);
  }
  const snippets: AttachedSnippet[] = [];
  for (let match = SNIPPET.exec(rest); match !== null; match = SNIPPET.exec(rest)) {
    const label = match[1]?.trim();
    const quoted = match[2]!.replace(/\n$/, "").split("\n").map((line) => (line.startsWith("> ") ? line.slice(2) : line.slice(1)));
    snippets.push({ ...(label !== undefined && label !== "" ? { label } : {}), text: quoted.join("\n") });
    rest = rest.slice(match[0].length).replace(/^\n+/, "");
  }
  if (files.length === 0 && snippets.length === 0) return { text, files, snippets };
  return { text: rest.trim(), files, snippets };
}
