/**
 * 아이콘 — lucide 한 벌만 쓴다. 크기는 글자를 따라 em 이고 선 굵기는 CSS(`.icon`)가 화면 픽셀로 정한다.
 * 도구·권한 모드마다 그림 하나를 고정해 카드·칩·시트가 같은 그림을 쓴다
 */
import {
  Bot, FilePen, FilePlus, FileSearch, FileText, Globe, ListChecks, Map, MessageCircleQuestion, NotebookPen, Puzzle,
  ShieldCheck, ShieldOff, SquareTerminal, TextSearch, WandSparkles, Wrench, type LucideIcon,
} from "lucide-react";

export function Icon({ icon: Glyph, className }: { icon: LucideIcon; className?: string }) {
  return <Glyph className={className === undefined ? "icon" : `icon ${className}`} aria-hidden="true" focusable="false" />;
}

export function toolIcon(name: string): LucideIcon {
  switch (name) {
    case "Read": return FileText;
    case "Edit":
    case "MultiEdit": return FilePen;
    case "Write": return FilePlus;
    case "NotebookEdit": return NotebookPen;
    case "Bash":
    case "UserShell":
    case "BashOutput":
    case "KillShell": return SquareTerminal;
    case "Grep": return TextSearch;
    case "Glob": return FileSearch;
    case "WebFetch":
    case "WebSearch": return Globe;
    case "Task":
    case "Agent": return Bot;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate": return ListChecks;
    case "AskUserQuestion": return MessageCircleQuestion;
    case "ExitPlanMode": return Map;
    case "Skill": return WandSparkles;
    default: return name.startsWith("mcp__") ? Puzzle : Wrench;
  }
}

/** 한 줄 요약이 경로·명령·패턴인 도구 — 이 줄만 고정폭으로 보인다. 질문·서브에이전트 같은 글은 본문 글꼴이다 */
const CODE_LINE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "UserShell", "BashOutput", "KillShell", "Grep", "Glob", "WebFetch"]);

export function isCodeLine(name: string): boolean {
  return CODE_LINE_TOOLS.has(name);
}

export function modeIcon(mode: string): LucideIcon {
  switch (mode) {
    case "acceptEdits": return FilePen;
    case "plan": return Map;
    case "bypassPermissions": return ShieldOff;
    default: return ShieldCheck;
  }
}
