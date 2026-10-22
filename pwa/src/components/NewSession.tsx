/**
 * 새 세션 — 프로젝트 폴더는 Mac 설정에 등록한 폴더와 Claude Code 기록에 나온 폴더에서만 고른다(임의 경로 입력 없음).
 * 위에서 폴더를 고르고(라디오 묶음) 아래 도크의 입력 카드에 첫 프롬프트를 쓴다 — 대화 화면의 입력 카드와 같은 자리다.
 * 권한 모드 기본값은 그 폴더에서 마지막으로 고른 모드, 없으면 Mac 설정이다(plan 은 기억하지 않는다).
 * 모델 선택지는 claude 가 알려 준 목록이고 노력도는 그 모델이 받는 단계만 보인다. 기본값은 Mac 설정이다
 */
import { Check, Cpu, Folder, FolderOpen, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectCandidate } from "../../../shared/src/protocol.ts";
import { api } from "../api.ts";
import { effortsFor, findModel, modelChoices, navigate, relativeTime, routeHref, useHeightVar, useModels, useNow, useScrolledPast } from "../hooks.ts";
import { toastError, useAppState } from "../store.ts";
import { ComposerCard, ModeModelChips, effortOptions, permissionModeOptions, shouldSend, useAttachments, useAutosize } from "./Composer.tsx";
import { Icon } from "./icons.tsx";
import { NavBar } from "./NavBar.tsx";
import { ChoiceSheet } from "./Sheet.tsx";

export function NewSession({ wide }: { wide: boolean }) {
  const config = useAppState((state) => state.config);
  const [projects, setProjects] = useState<ProjectCandidate[] | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  // 고르기 전에는 Mac 설정의 기본값 — 설정은 화면을 연 뒤에 올 수 있어 처음 값으로 굳히지 않는다
  const [modelChoice, setModel] = useState<string | undefined>(undefined);
  const [effortChoice, setEffort] = useState<string | undefined>(undefined);
  const model = modelChoice ?? config?.defaultModel ?? "";
  const effort = effortChoice ?? config?.defaultEffort ?? "";
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"project" | "prompt" | undefined>(undefined);
  const [sheet, setSheet] = useState<"model" | "mode" | "effort" | undefined>(undefined);
  const models = useModels();
  const attachments = useAttachments(config?.limits);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLFieldSetElement>(null);
  const collapsed = useScrolledPast(scroll, 36);
  const now = useNow();
  const dock = useHeightVar("--dock-h");
  useAutosize(textarea, prompt);

  useEffect(() => {
    api.projects().then((result) => setProjects(result.projects), (error: unknown) => toastError(error, "프로젝트를 받지 못했습니다. 연결을 확인하고 화면을 다시 여십시오."));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (projects ?? []).filter((project) => needle === "" || project.path.toLowerCase().includes(needle));
  }, [projects, query]);
  const chosen = projects?.find((project) => project.path === cwd);
  const effectiveMode = mode ?? chosen?.lastPermissionMode ?? config?.defaultPermissionMode ?? "default";
  const choices = modelChoices(models);
  const modelName = choices.find((choice) => choice.value === model)?.label ?? model;
  // 노력도를 받지 않는 모델(Haiku 4.5)이면 칩을 빼고 보내지도 않는다. 그 모델이 받지 않는 단계는 보내지 않는다
  const efforts = effortsFor(findModel(models, model), models !== undefined);
  const effectiveEffort = efforts?.includes(effort) === true ? effort : "";

  // 고르지 않았거나 비었으면 막지 않고 눌렀을 때 알린다 — 무엇이 빠졌는지 그 자리로 초점을 옮긴다
  const start = async () => {
    if (busy || !attachments.ready) return;
    if (cwd === undefined) {
      setProblem("project");
      list.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (prompt.trim() === "" && attachments.ids.length === 0) {
      setProblem("prompt");
      textarea.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await api.createSession({
        cwd, prompt, attachments: attachments.ids, permissionMode: effectiveMode, ...(model !== "" ? { model } : {}),
        ...(effectiveEffort !== "" ? { effort: effectiveEffort } : {}),
      });
      navigate({ name: "session", sessionId: result.sessionId }, true);
    } catch (error) {
      toastError(error, "세션을 시작하지 못했습니다. Mac 이 깨어 있는지 확인하고 다시 시작하십시오.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen form-screen new-screen">
      <NavBar title="새 세션" collapsed={collapsed} edge={collapsed} {...(!wide ? { back: { href: routeHref({ name: "list" }), label: "세션 목록" } } : {})} />
      <div className="form-scroll" ref={scroll}>
        <div className="form-column">
          <div className="hero">
            <h1 className="page-title">새 세션</h1>
            <p className="hero-sub">프로젝트를 고르고 첫 프롬프트를 씁니다</p>
          </div>
          <section className="section" aria-labelledby="projects-head">
            <h2 id="projects-head" className="section-head">프로젝트{projects !== undefined ? <span className="count">{projects.length}</span> : null}</h2>
            <div className="search section-search">
              <Icon icon={Search} />
              <input type="search" placeholder="폴더 검색" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="프로젝트 검색" enterKeyHint="search" />
              {query !== "" ? <button type="button" className="icon-btn" onClick={() => setQuery("")} aria-label="검색 지우기"><Icon icon={X} /></button> : null}
            </div>
            {projects === undefined ? <p className="section-foot" role="status"><span className="spinner" aria-hidden="true" /> 프로젝트를 받는 중…</p> : null}
            {projects !== undefined && projects.length === 0 ? (
              <div className="empty-card">
                <Icon icon={FolderOpen} className="empty-icon" />
                <p className="empty-title">고를 프로젝트가 없습니다</p>
                <p className="empty-text">Mac 메뉴바의 light 설정에서 프로젝트 폴더를 등록하면 여기에 보입니다.</p>
              </div>
            ) : null}
            {projects !== undefined && projects.length > 0 && filtered.length === 0 ? (
              <p className="section-foot">「{query.trim()}」가 든 폴더가 없습니다.</p>
            ) : null}
            {filtered.length > 0 ? (
              <fieldset ref={list} className="group project-list" aria-describedby={problem === "project" ? "project-problem" : undefined}>
                <legend className="sr-only">프로젝트</legend>
                {filtered.slice(0, 60).map((project) => {
                  const selected = project.path === cwd;
                  return (
                    <label key={project.path} className={`group-row project-row ${selected ? "selected" : ""}`}>
                      <input
                        type="radio" name="project" className="sr-only" value={project.path} checked={selected}
                        onChange={() => {
                          setCwd(project.path);
                          setProblem(undefined);
                        }}
                      />
                      <span className="row-tile"><Icon icon={Folder} /></span>
                      <span className="row-text">
                        <span className="row-line">
                          <span className="row-title">{project.name}</span>
                          <span className="row-time">{project.lastUsedAt !== undefined ? relativeTime(project.lastUsedAt, now) : project.source === "settings" ? "등록한 폴더" : ""}</span>
                        </span>
                        {/* 앞쪽부터 줄이려 rtl 로 두므로 LRM 으로 경로의 글자 순서를 지킨다. 고른 줄은 경로를 다 보인다 */}
                        <span className="row-sub project-path">{`‎${project.path}‎`}</span>
                      </span>
                      <span className="row-trail">{selected ? <Icon icon={Check} className="bold check" /> : null}</span>
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
            {problem === "project" ? <p id="project-problem" className="field-error" role="alert">시작할 프로젝트를 먼저 고르십시오.</p> : null}
          </section>
        </div>
      </div>
      <div className="dock chrome" ref={dock}>
        <div className="dock-column">
          <div className="dock-status">
            <p className={`dock-facts ${problem === "prompt" ? "danger" : ""}`} role={problem === "prompt" ? "alert" : undefined}>
              {problem === "prompt" ? "첫 프롬프트를 적거나 무엇을 붙이십시오." : chosen !== undefined ? <><Icon icon={Folder} className="small" /><span>{chosen.name} 에서 시작</span></> : "위에서 프로젝트를 고르십시오"}
            </p>
          </div>
          <ComposerCard
            attachments={attachments}
            toolbar={(
              <ModeModelChips
                mode={effectiveMode} model={modelName} verb="고르기" onMode={() => setSheet("mode")} onModel={() => setSheet("model")}
                {...(efforts !== undefined ? { effort: effectiveEffort, onEffort: () => setSheet("effort") } : {})}
              />
            )}
            action={(
              <button type="button" className="btn btn-primary start-button" aria-disabled={busy || !attachments.ready || undefined} onClick={() => void start()}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}{busy ? "시작하는 중" : "시작"}
              </button>
            )}
          >
            <textarea
              ref={textarea} className="composer-input" rows={1} value={prompt} placeholder="무엇을 맡길까요?" aria-label="첫 프롬프트" enterKeyHint="send"
              onChange={(event) => {
                setPrompt(event.target.value);
                if (problem === "prompt") setProblem(undefined);
              }}
              onKeyDown={(event) => {
                if (shouldSend(event)) {
                  event.preventDefault();
                  void start();
                }
              }}
            />
          </ComposerCard>
        </div>
      </div>
      {sheet === "model" ? (
        <ChoiceSheet title="모델" value={model} options={choices.map((choice) => ({ ...choice, icon: Cpu }))} onChoose={setModel} onClose={() => setSheet(undefined)} />
      ) : null}
      {sheet === "effort" && efforts !== undefined ? (
        <ChoiceSheet
          title="노력도" value={effectiveEffort} options={effortOptions(efforts)} onChoose={setEffort} onClose={() => setSheet(undefined)}
          note="깊이 생각할수록 답이 느려지고 사용량이 늡니다."
        />
      ) : null}
      {sheet === "mode" ? (
        <ChoiceSheet
          title="권한 모드" value={effectiveMode} onChoose={setMode} onClose={() => setSheet(undefined)}
          options={permissionModeOptions()}
        />
      ) : null}
    </div>
  );
}
