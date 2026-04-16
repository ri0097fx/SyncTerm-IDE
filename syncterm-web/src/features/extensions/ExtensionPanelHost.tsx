import React from "react";
import { useExtensionRuntime } from "./ExtensionRuntimeContext";
import { PanelSettingsDropdown } from "./PanelSettingsDropdown";
import { SolitaireBoard } from "./SolitairePanel";
import { useSession } from "../session/SessionContext";
import { api } from "../../lib/api";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

interface ExtensionPanelHostProps {
  panelId: string | null;
  isDockedToEditor?: boolean;
  onToggleDock?: () => void;
}

const TETRIS_SHAPES: Record<number, number[][]> = {
  1: [[1, 1, 1, 1]], // I
  2: [[1, 1], [1, 1]], // O
  3: [[0, 1, 0], [1, 1, 1]], // T
  4: [[0, 0, 1], [1, 1, 1]], // L
  5: [[1, 0, 0], [1, 1, 1]], // J
  6: [[0, 1, 1], [1, 1, 0]], // S
  7: [[1, 1, 0], [0, 1, 1]] // Z
};

const TETRIS_NAMES: Record<number, string> = {
  1: "I",
  2: "O",
  3: "T",
  4: "L",
  5: "J",
  6: "S",
  7: "Z"
};

const NON_GAME_EXTENSION_IDS = new Set([
  "devtools.json-lab",
  "devtools.regex-lab",
  "devtools.diff-notes",
  "devtools.api-status",
  "productivity.pomodoro",
  "productivity.kanban-lite",
  "productivity.scratchpad",
  "productivity.habit-tracker",
  "productivity.calendar-planner",
  "productivity.goal-tracker-pro",
  "productivity.time-blocker",
  "productivity.weekly-review",
  "productivity.meeting-notes",
  "productivity.notion-notes",
  "productivity.paper-manager"
]);

function parseTetrisEncoded(enc: string): number[][] {
  if (!enc) return [];
  return enc.split("/").map((row) => row.split("").map((ch) => Number(ch) || 0));
}

function filterViewStats(stats: Record<string, string | number>): [string, string | number][] {
  return Object.entries(stats).filter(([k]) => !k.startsWith("_"));
}

function tilePow2048(v: number): number {
  if (v <= 0) return 0;
  let n = 0;
  let x = v;
  while (x > 1 && n < 24) {
    x /= 2;
    n += 1;
  }
  return n;
}


function extractBlock(items: string[] | undefined, startLabel: string, endLabel: string): string {
  if (!items || items.length === 0) return "";
  const s = items.indexOf(startLabel);
  if (s < 0) return "";
  const e = items.indexOf(endLabel);
  const to = e > s ? e : items.length;
  return items.slice(s + 1, to).join("\n");
}

function parseDiffRows(items: string[] | undefined): Array<{ done: boolean; priority: string; text: string; idx: number }> {
  if (!items) return [];
  return items
    .map((line) => {
      const m = line.match(/^\[( |x)\]\s+\(([^)]+)\)\s+(.+)\s+#(\d+)$/i);
      if (!m) return null;
      return { done: m[1].toLowerCase() === "x", priority: m[2], text: m[3], idx: Math.max(0, Number(m[4]) - 1) };
    })
    .filter((x): x is { done: boolean; priority: string; text: string; idx: number } => !!x);
}

function parseApiRows(items: string[] | undefined): Array<{ ok: boolean; name: string; latency: number; fail: number; at: string }> {
  if (!items) return [];
  return items
    .map((line) => {
      const m = line.match(/^(OK|NG)\s+(.+?)\s+latency=(\d+)ms\s+fail=(\d+)\s+at\s+(.+)$/);
      if (!m) return null;
      return { ok: m[1] === "OK", name: m[2], latency: Number(m[3]) || 0, fail: Number(m[4]) || 0, at: m[5] };
    })
    .filter((x): x is { ok: boolean; name: string; latency: number; fail: number; at: string } => !!x);
}

export const ExtensionPanelHost: React.FC<ExtensionPanelHostProps> = ({ panelId, isDockedToEditor = false, onToggleDock }) => {
  const { panels, runCommand, execDirect } = useExtensionRuntime();
  const { currentWatcher, currentSession } = useSession();

  const panel = panels.find((x) => x.id === panelId);

  const panelHeader = panel ? (
    <div className="pane-header">
      <span className="pane-title">{panel.title}</span>
      {onToggleDock && (
        <PanelSettingsDropdown isDockedToEditor={isDockedToEditor} onToggleDock={onToggleDock} />
      )}
    </div>
  ) : null;
  const [inputA, setInputA] = React.useState("");
  const [inputB, setInputB] = React.useState("");
  const [inputC, setInputC] = React.useState("");
  const [priority, setPriority] = React.useState("medium");
  const [weeklyType, setWeeklyType] = React.useState("wins");
  const pdfInputRef = React.useRef<HTMLInputElement | null>(null);
  const [pdfTargetId, setPdfTargetId] = React.useState<number | null>(null);
  const [aiExtracting, setAiExtracting] = React.useState<number | null>(null);
  const [selectedPaperId, setSelectedPaperId] = React.useState<number | null>(null);
  const [paperNoteEdit, setPaperNoteEdit] = React.useState("");
  const paperNoteEditorFocused = React.useRef(false);

  React.useEffect(() => {
    if (paperNoteEditorFocused.current || selectedPaperId === null) return;
    const items = panel?.model?.items ?? [];
    for (const l of items) {
      if (!l.startsWith("PJ:")) continue;
      try {
        const p = JSON.parse(l.slice(3));
        if (Number(p.id) === selectedPaperId) { setPaperNoteEdit(String(p.notes || "")); break; }
      } catch { /* skip */ }
    }
  }, [panel?.model?.items, selectedPaperId]);

  const pendingAiExtractRef = React.useRef<number | null>(null);

  const handlePdfSelect = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || pdfTargetId === null) return;
    const targetId = pdfTargetId;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      console.log("[PaperManager] Attaching PDF, size:", dataUrl.length, "for paper:", targetId);
      execDirect(PM, `${PM}.attachPdf`, [targetId, dataUrl]);
      if (currentWatcher && currentSession) {
        pendingAiExtractRef.current = targetId;
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, [pdfTargetId, execDirect, currentWatcher, currentSession]);

  const readExtStorage = React.useCallback((extId: string, field: string): unknown => {
    try {
      const raw = localStorage.getItem(`syncterm.ext.${extId}`);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj?.[field] ?? null;
    } catch { return null; }
  }, []);

  const handleViewPdf = React.useCallback((paperId: number) => {
    const dataUrl = readExtStorage("productivity.paper-manager", `pdf_${paperId}`);
    if (typeof dataUrl === "string" && dataUrl) {
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(`<html><head><title>PDF</title></head><body style="margin:0"><iframe src="${dataUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
        win.document.close();
      }
    }
  }, [readExtStorage]);

  const extractTextFromPdf = React.useCallback(async (dataUrl: string): Promise<string> => {
    try {
      const base64 = dataUrl.split(",")[1] || "";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const pdf = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: true }).promise;
      const pages = Math.min(pdf.numPages, 15);
      const textParts: string[] = [];
      for (let i = 1; i <= pages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .filter((item): item is { str: string } => "str" in item)
          .map((item) => item.str)
          .join(" ");
        if (pageText.trim()) textParts.push(pageText.trim());
        if (textParts.join(" ").length > 8000) break;
      }
      const result = textParts.join("\n").slice(0, 8000);
      console.log("[PDF Extract] Got", result.length, "chars from", pages, "pages");
      return result;
    } catch (err) {
      console.error("[PDF Extract] Error:", err);
      return "";
    }
  }, []);

  const PM = "productivity.paper-manager";
  const pmExec = React.useCallback((cmd: string, args?: unknown[]) => {
    execDirect(PM, `${PM}.${cmd}`, args);
  }, [execDirect]);

  const handleAiExtract = React.useCallback(async (paperId: number) => {
    if (!currentWatcher || !currentSession) return;
    setAiExtracting(paperId);
    const exec = (cmd: string, args: unknown[]) => {
      console.log("[AI Extract] exec:", cmd, args);
      execDirect(PM, `${PM}.${cmd}`, args);
    };
    try {
      const dataUrlRaw = readExtStorage(PM, `pdf_${paperId}`);
      console.log("[AI Extract] pdf data found:", typeof dataUrlRaw === "string" ? `${(dataUrlRaw as string).length} chars` : "null");
      const dataUrl = typeof dataUrlRaw === "string" ? (dataUrlRaw as string) : null;
      if (!dataUrl) {
        exec("setNotes", [paperId, "(No PDF data found - please re-attach)"]);
        setAiExtracting(null);
        return;
      }
      const pdfText = await extractTextFromPdf(dataUrl);
      console.log("[AI Extract] extracted text length:", pdfText.length);
      exec("setNotes", [paperId, "⏳ AI analyzing..."]);
      const prompt = pdfText.length >= 30
        ? `You are a research paper metadata extractor. Given text extracted from a PDF, respond with ONLY this JSON (no markdown fences, no explanation):\n{"title":"...","authors":"...","year":0,"venue":"...","tags":["tag1","tag2"],"summary":"2-3 sentence summary"}\nUnknown fields: use "" or 0. Tags: 2-5 lowercase keywords.\n\n--- TEXT ---\n${pdfText.slice(0, 6000)}`
        : `You are a research paper metadata extractor. I have a PDF but could not extract text. Based on common paper formats, please respond with this JSON:\n{"title":"","authors":"","year":0,"venue":"","tags":[],"summary":"Could not extract text from PDF."}\nRespond ONLY with JSON.`;
      console.log("[AI Extract] calling AI API...");
      const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
        path: "", action: "chat", prompt, fileContent: "", history: []
      });
      const raw = (res.result || "").trim();
      console.log("[AI Extract] AI response:", raw.slice(0, 200));
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log("[AI Extract] parsed:", parsed);
          if (parsed.title) exec("setMeta", [paperId, parsed.title, parsed.authors || "", parsed.year || 0, parsed.venue || ""]);
          exec("setNotes", [paperId, parsed.summary || raw.slice(0, 500)]);
          if (Array.isArray(parsed.tags)) {
            for (const tag of parsed.tags) exec("addTag", [paperId, String(tag)]);
          }
        } catch (parseErr) {
          console.error("[AI Extract] JSON parse error:", parseErr);
          exec("setNotes", [paperId, `(Parse error) ${raw.slice(0, 400)}`]);
        }
      } else {
        exec("setNotes", [paperId, raw.slice(0, 500) || "(AI returned empty response)"]);
      }
    } catch (err) {
      console.error("[AI Extract] error:", err);
      exec("setNotes", [paperId, `Error: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setAiExtracting(null);
    }
  }, [currentWatcher, currentSession, extractTextFromPdf, execDirect, readExtStorage]);

  React.useEffect(() => {
    if (pendingAiExtractRef.current !== null && aiExtracting === null) {
      const id = pendingAiExtractRef.current;
      pendingAiExtractRef.current = null;
      const timer = setTimeout(() => handleAiExtract(id), 600);
      return () => clearTimeout(timer);
    }
  }, [aiExtracting, handleAiExtract, panel?.model?.items]);

  React.useEffect(() => {
    if (!panel) return;
    const items = panel.model?.items ?? [];
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    if (panel.extensionId === "devtools.json-lab") {
      setInputA(extractBlock(items, "Current JSON:", "History:"));
    } else if (panel.extensionId === "devtools.regex-lab") {
      setInputA(String(stats.pattern ?? ""));
      setInputB(String(stats.flags ?? ""));
      setInputC(extractBlock(items, "Target text:", "Matches:"));
    } else if (panel.extensionId === "productivity.scratchpad") {
      setInputA(items.join("\n"));
    }
  }, [panel?.id, panel?.extensionId, panel?.model?.items, panel?.model?.stats]);

  React.useEffect(() => {
    if (!panel) return;
    const extId = panel.extensionId;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const key = e.key;
      if (extId === "game.puzzle-2048-lite") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.left`); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.right`); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.up`); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.down`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
      } else if (extId === "game.arcade-snake-lite") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.dir`, ["L"]); runCommand(`${extId}.step`); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.dir`, ["R"]); runCommand(`${extId}.step`); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.dir`, ["U"]); runCommand(`${extId}.step`); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.dir`, ["D"]); runCommand(`${extId}.step`); }
        else if (key === " " || key === "Enter") { e.preventDefault(); runCommand(`${extId}.step`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
      } else if (extId === "game.puzzle-tetris") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.left`); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.right`); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.rotate`); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.tick`); }
        else if (key === " ") { e.preventDefault(); runCommand(`${extId}.drop`); }
        else if (key.toLowerCase() === "c") { e.preventDefault(); runCommand(`${extId}.hold`); }
        else if (key.toLowerCase() === "p") { e.preventDefault(); runCommand(`${extId}.pause`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
      } else if (extId === "game.word-wordsprint") {
        if (key === "1" || key === "2" || key === "3") {
          e.preventDefault();
          const pickActions = (panel.model?.actions ?? []).filter((a) => a.command === `${extId}.pick`);
          const idx = Number(key) - 1;
          const target = pickActions[idx];
          if (target) runCommand(target.command, target.args);
        } else if (key.toLowerCase() === "n") {
          e.preventDefault();
          runCommand(`${extId}.new`);
        }
      } else if (extId === "game.puzzle-minesweeper") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.cursor`, [-1, 0]); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.cursor`, [1, 0]); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.cursor`, [0, -1]); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.cursor`, [0, 1]); }
        else if (key === " " || key === "Enter") { e.preventDefault(); runCommand(`${extId}.reveal`); }
        else if (key.toLowerCase() === "f") { e.preventDefault(); runCommand(`${extId}.flag`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
      } else if (extId === "game.puzzle-sudoku-pro") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.cursor`, [-1, 0]); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.cursor`, [1, 0]); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.cursor`, [0, -1]); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.cursor`, [0, 1]); }
        else if (/^[1-9]$/.test(key)) { e.preventDefault(); runCommand(`${extId}.set`, [Number(key)]); }
        else if (key === "0" || key === "Backspace" || key === "Delete") { e.preventDefault(); runCommand(`${extId}.clear`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
        else if (key.toLowerCase() === "l") { e.preventDefault(); runCommand(`${extId}.levelCycle`); }
      } else if (extId === "game.board-connect-four") {
        if (/^[1-7]$/.test(key)) { e.preventDefault(); runCommand(`${extId}.drop`, [Number(key) - 1]); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
        else if (key.toLowerCase() === "m") { e.preventDefault(); runCommand(`${extId}.mode`); }
      } else if (extId === "game.puzzle-puyo-burst") {
        if (key === "ArrowLeft") { e.preventDefault(); runCommand(`${extId}.left`); }
        else if (key === "ArrowRight") { e.preventDefault(); runCommand(`${extId}.right`); }
        else if (key === "ArrowUp") { e.preventDefault(); runCommand(`${extId}.rot`); }
        else if (key === "ArrowDown") { e.preventDefault(); runCommand(`${extId}.tick`); }
        else if (key === " ") { e.preventDefault(); runCommand(`${extId}.drop`); }
        else if (key.toLowerCase() === "n") { e.preventDefault(); runCommand(`${extId}.new`); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel, runCommand]);

  if (!panel) {
    return (
      <div className="pane extension-panel-pane">
        <div className="pane-header">
          <span className="pane-title">Extension Panel</span>
        </div>
        <div className="pane-body extension-panel-body">表示できる拡張パネルがありません。</div>
      </div>
    );
  }

  if (panel.extensionId === "game.puzzle-tetris") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const legacyBoard = typeof stats._board === "string" ? stats._board : "";
    const lockedRows = parseTetrisEncoded(typeof stats._locked === "string" ? stats._locked : "");
    const ghostRows = parseTetrisEncoded(typeof stats._ghost === "string" ? stats._ghost : "");
    const pieceRows = parseTetrisEncoded(typeof stats._piece === "string" ? stats._piece : "");
    const boardRows =
      lockedRows.length > 0
        ? lockedRows
        : legacyBoard
          ? parseTetrisEncoded(legacyBoard)
          : [];
    const nextIds = typeof stats._nextIds === "string"
      ? stats._nextIds.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0)
      : [];
    const holdId = typeof stats._holdId === "string" ? Number(stats._holdId) : 0;
    const holdUsed = stats._holdUsed === "1";
    const viewStats = filterViewStats(stats);

    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="tetris-runtime">
            <div className="tetris-board">
              {boardRows.map((row, rIdx) => (
                <div key={`row-${rIdx}`} className="tetris-row">
                  {row.map((_cell, cIdx) => {
                    const pieceId = pieceRows[rIdx]?.[cIdx] ?? 0;
                    const ghostId = ghostRows[rIdx]?.[cIdx] ?? 0;
                    const lockedId = lockedRows.length > 0 ? lockedRows[rIdx]?.[cIdx] ?? 0 : 0;
                    const legacyId = legacyBoard && !lockedRows.length ? boardRows[rIdx]?.[cIdx] ?? 0 : 0;
                    const solidId = pieceId || (lockedRows.length > 0 ? lockedId : legacyId);
                    const ghostOnly = !solidId && ghostId;
                    const empty = !solidId && !ghostOnly;
                    const cls = [
                      "tetris-cell",
                      solidId ? `tetris-cell-solid tetris-cell-${solidId}` : "",
                      ghostOnly ? `tetris-cell-ghost tetris-cell-${ghostId}` : "",
                      empty ? "tetris-cell-0" : ""
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return <span key={`cell-${rIdx}-${cIdx}`} className={cls} />;
                  })}
                </div>
              ))}
            </div>
            <div className="tetris-side">
              <div className="tetris-mini-block">
                <div className="tetris-mini-title">HOLD {holdUsed ? "(used)" : ""}</div>
                {holdId > 0 ? (
                  <>
                    <div className="tetris-mini-name">{TETRIS_NAMES[holdId] ?? "?"}</div>
                    <div className="tetris-mini-shape">
                      {(TETRIS_SHAPES[holdId] ?? []).map((row, rIdx) => (
                        <div key={`hold-row-${rIdx}`} className="tetris-row">
                          {row.map((v, cIdx) => (
                            <span
                              key={`hold-cell-${rIdx}-${cIdx}`}
                              className={v ? `tetris-cell tetris-cell-solid tetris-cell-${holdId}` : "tetris-cell tetris-cell-0"}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="tetris-mini-empty">-</div>
                )}
              </div>
              <div className="tetris-mini-block">
                <div className="tetris-mini-title">NEXT</div>
                {nextIds.slice(0, 4).map((id, idx) => (
                  <div key={`next-${idx}-${id}`} className="tetris-next-item">
                    <div className="tetris-mini-name">{idx + 1}. {TETRIS_NAMES[id] ?? "?"}</div>
                    <div className="tetris-mini-shape">
                      {(TETRIS_SHAPES[id] ?? []).map((row, rIdx) => (
                        <div key={`next-row-${idx}-${rIdx}`} className="tetris-row">
                          {row.map((v, cIdx) => (
                            <span
                              key={`next-cell-${idx}-${rIdx}-${cIdx}`}
                              className={v ? `tetris-cell tetris-cell-solid tetris-cell-${id}` : "tetris-cell tetris-cell-0"}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {panel.model?.items && panel.model.items.length > 0 && (
            <div className="extension-panel-items">
              {panel.model.items.map((item, idx) => (
                <pre key={`${panel.id}-${idx}`} className="extension-panel-item-line">{item}</pre>
              ))}
            </div>
          )}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions.map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.puzzle-2048-lite") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const gridStr = typeof stats._grid2048 === "string" ? stats._grid2048 : "";
    const rows = gridStr ? gridStr.split("/").map((r) => r.split("|").map((x) => Number(x) || 0)) : [];
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="game-board-2048">
            {rows.map((row, rIdx) => (
              <div key={`g48-${rIdx}`} className="game-board-2048-row">
                {row.map((v, cIdx) => (
                    <div
                      key={`g48c-${rIdx}-${cIdx}`}
                      className={
                        v === 0
                          ? "game-tile-2048 game-tile-2048-empty"
                          : `game-tile-2048 game-tile-2048-pow-${Math.min(tilePow2048(v), 16)}`
                      }
                    >
                      {v > 0 ? String(v) : ""}
                    </div>
                  ))}
              </div>
            ))}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions.map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.arcade-snake-lite") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const enc = typeof stats._snake === "string" ? stats._snake : "";
    const gridRows = enc ? enc.split("/").map((r) => r.split("").map((ch) => Number(ch) || 0)) : [];
    const nh = typeof stats._nextHead === "string" ? stats._nextHead.split(",").map((x) => Number(x.trim())) : [];
    const nhx = nh[0] ?? -1;
    const nhy = nh[1] ?? -1;
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="game-snake-wrap">
            <div className="game-snake-dir" aria-hidden title="進行方向">
              {(() => {
                const d = String(stats._dir ?? "");
                if (d === "U") return "↑";
                if (d === "D") return "↓";
                if (d === "L") return "←";
                if (d === "R") return "→";
                return "—";
              })()}
            </div>
            <div className="game-board-snake">
              {gridRows.map((row, rIdx) => (
                <div key={`snk-${rIdx}`} className="game-board-snake-row">
                  {row.map((cell, cIdx) => {
                    const showNext = nhx === cIdx && nhy === rIdx && stats.state === "alive";
                    const cls = [
                      "game-snake-cell",
                      cell === 1 ? "game-snake-food" : "",
                      cell === 2 ? "game-snake-head" : "",
                      cell === 3 ? "game-snake-body" : "",
                      cell === 0 ? "game-snake-empty" : "",
                      showNext && (cell === 0 || cell === 1) ? "game-snake-next" : ""
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return <span key={`snkc-${rIdx}-${cIdx}`} className={cls} />;
                  })}
                </div>
              ))}
            </div>
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions.map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.board-othello-mini") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const flat = typeof stats._othello === "string" ? stats._othello : "";
    const legalRaw = typeof stats._legal === "string" ? stats._legal : "";
    const legalSet = new Set<string>();
    if (legalRaw) {
      legalRaw.split(";").forEach((p) => {
        if (!p.trim()) return;
        const parts = p.split(",").map((x) => Number(x.trim()));
        if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) legalSet.add(`${parts[0]},${parts[1]}`);
      });
    }
    const cells = flat.length === 64 ? flat.split("") : [];
    const viewStats = filterViewStats(stats);
    const extId = panel.extensionId;
    const canHumanMove = String(stats._canHumanMove ?? "1") === "1";
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="game-board-othello">
            {Array.from({ length: 8 }).map((_, rIdx) => (
              <div key={`oth-${rIdx}`} className="game-board-othello-row">
                {Array.from({ length: 8 }).map((__, cIdx) => {
                  const ch = cells[rIdx * 8 + cIdx] ?? ".";
                  const key = `${cIdx},${rIdx}`;
                  const isLegal = legalSet.has(key);
                  const disc = ch === "B" ? "black" : ch === "W" ? "white" : null;
                  const inner = (
                    <>
                      {disc ? <span className={`game-othello-disc game-othello-disc-${disc}`} /> : null}
                      {isLegal && !disc ? <span className="game-othello-hint" /> : null}
                    </>
                  );
                  if (isLegal && canHumanMove) {
                    return (
                      <button
                        key={`othc-${rIdx}-${cIdx}`}
                        type="button"
                        className="game-othello-cell game-othello-legal"
                        onClick={() => runCommand(`${extId}.move`, [cIdx, rIdx])}
                      >
                        {inner}
                      </button>
                    );
                  }
                  return (
                    <div key={`othc-${rIdx}-${cIdx}`} className="game-othello-cell">
                      {inner}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions.map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.word-wordsprint") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const scramble = typeof stats._scramble === "string" ? stats._scramble : "";
    const choices = typeof stats._choices === "string" ? stats._choices.split("|").filter(Boolean) : [];
    const viewStats = filterViewStats(stats);
    const extId = panel.extensionId;
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="game-word-sprint">
            <div className="game-word-label">並び替え</div>
            <div className="game-word-scramble">
              {scramble.split("").map((ch, i) => (
                <span key={`sc-${i}-${ch}`} className="game-word-chip">
                  {ch}
                </span>
              ))}
            </div>
            <div className="game-word-label">正解を選ぶ</div>
            <div className="game-word-choices">
              {choices.map((word, idx) => (
                <button
                  key={`choice-${idx}-${word}`}
                  type="button"
                  className="game-word-choice-btn"
                  onClick={() => runCommand(`${extId}.pick`, [word])}
                >
                  <span className="game-word-choice-idx">{idx + 1}</span>
                  <span className="game-word-choice-text">{word}</span>
                </button>
              ))}
            </div>
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions
                .filter((a) => !String(a.command).endsWith(".pick"))
                .map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.puzzle-minesweeper") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const flat = typeof stats._ms === "string" ? stats._ms : "";
    const cx = Number(stats._cx) || 0;
    const cy = Number(stats._cy) || 0;
    const W = Math.max(1, Number(stats._w) || 9);
    const H = Math.max(1, Number(stats._h) || 9);
    const cellPx = W >= 30 ? 14 : (W >= 16 ? 16 : 22);
    const fontPx = W >= 30 ? 9 : (W >= 16 ? 10 : 12);
    const viewStats = filterViewStats(stats);
    const rows: string[][] = [];
    for (let y = 0; y < H; y += 1) {
      const row: string[] = [];
      for (let x = 0; x < W; x += 1) row.push(flat[y * W + x] ?? "H");
      rows.push(row);
    }
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && (
            <div className="extension-panel-stats">
              {viewStats.map(([k, v]) => (
                <div key={k} className="extension-panel-stat-item">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="game-board-minesweeper">
            {rows.map((row, rIdx) => (
              <div key={`ms-${rIdx}`} className="game-board-minesweeper-row">
                {row.map((cell, cIdx) => {
                  const cursor = cx === cIdx && cy === rIdx;
                  const num = /^[1-8]$/.test(cell) ? cell : "";
                  const cls = [
                    "game-ms-cell",
                    cell === "H" ? "game-ms-hidden" : "",
                    cell === "F" ? "game-ms-flag" : "",
                    cell === "M" ? "game-ms-mine" : "",
                    cell === "0" ? "game-ms-open0" : "",
                    num ? `game-ms-n${num}` : "",
                    cursor ? "game-ms-cursor" : ""
                  ]
                    .filter(Boolean)
                    .join(" ");
                  let label = "";
                  if (cell === "F") label = "⚑";
                  else if (cell === "M") label = "✹";
                  else if (cell === "H") label = "";
                  else if (cell === "0") label = "";
                  else label = cell;
                  return (
                    <span
                      key={`msc-${rIdx}-${cIdx}`}
                      className={cls}
                      style={{ width: `${cellPx}px`, height: `${cellPx}px`, fontSize: `${fontPx}px` }}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && (
            <div className="extension-panel-actions">
              {panel.model.actions.map((action, idx) => (
                <button
                  key={`${panel.id}-action-${idx}`}
                  className="icon-button"
                  style={{ width: "auto", padding: "0 0.6rem" }}
                  onClick={() => runCommand(action.command, action.args)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.puzzle-sudoku-pro") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const sdk = typeof stats._sdk === "string" ? stats._sdk : "";
    const givens = typeof stats._givens === "string" ? stats._givens : "";
    const cx = Number(stats._cx) || 0;
    const cy = Number(stats._cy) || 0;
    const rows = [];
    for (let y = 0; y < 9; y += 1) {
      const row: { v: string; g: boolean; c: boolean; sameLine: boolean; sameBox: boolean; err: boolean }[] = [];
      for (let x = 0; x < 9; x += 1) {
        const idx = y * 9 + x;
        const v = sdk[idx] && sdk[idx] !== "0" ? sdk[idx] : "";
        const g = givens[idx] === "1";
        const c = x === cx && y === cy;
        const sameLine = x === cx || y === cy;
        const sameBox = Math.floor(x / 3) === Math.floor(cx / 3) && Math.floor(y / 3) === Math.floor(cy / 3);
        let err = false;
        if (v) {
          for (let xx = 0; xx < 9; xx += 1) {
            if (xx !== x && sdk[y * 9 + xx] === v) { err = true; break; }
          }
          if (!err) {
            for (let yy = 0; yy < 9; yy += 1) {
              if (yy !== y && sdk[yy * 9 + x] === v) { err = true; break; }
            }
          }
        }
        row.push({ v, g, c, sameLine, sameBox, err });
      }
      rows.push(row);
    }
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && <div className="extension-panel-stats">{viewStats.map(([k,v]) => <div key={k} className="extension-panel-stat-item"><span>{k}</span><strong>{String(v)}</strong></div>)}</div>}
          <div className="game-board-sudoku">
            {rows.map((row, y) => (
              <div key={`sdk-${y}`} className="game-board-sudoku-row">
                {row.map((cell, x) => (
                  <button
                    key={`sdkc-${y}-${x}`}
                    type="button"
                    className={`game-sudoku-cell ${cell.g ? "game-sudoku-given" : "game-sudoku-user"} ${cell.c ? "game-sudoku-cursor" : ""} ${!cell.c && cell.sameLine ? "game-sudoku-same-line" : ""} ${!cell.c && cell.sameBox ? "game-sudoku-same-box" : ""} ${cell.err ? "game-sudoku-error" : ""} ${(x + 1) % 3 === 0 ? "game-sudoku-block-right" : ""} ${(y + 1) % 3 === 0 ? "game-sudoku-block-bottom" : ""}`}
                    onClick={() => runCommand(`${panel.extensionId}.cursor`, [x - cx, y - cy])}
                  >
                    {cell.v}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && <div className="extension-panel-actions">{panel.model.actions.map((action, idx) => <button key={`${panel.id}-action-${idx}`} className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={() => runCommand(action.command, action.args)}>{action.label}</button>)}</div>}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.board-connect-four") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const raw = typeof stats._c4 === "string" ? stats._c4 : "";
    const rows = raw
      ? raw.split("/").slice(0, 6).map((r) => r.slice(0, 7).split("").map((c) => Number(c) || 0))
      : Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => 0));
    const turn = Number(stats._turn) || 1;
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && <div className="extension-panel-stats">{viewStats.map(([k,v]) => <div key={k} className="extension-panel-stat-item"><span>{k}</span><strong>{String(v)}</strong></div>)}</div>}
          <div className="game-connect4-wrap">
            <div className="game-connect4-drop-row">
              {Array.from({ length: 7 }, (_, x) => (
                <button
                  key={`c4-drop-${x}`}
                  type="button"
                  className="game-connect4-drop-btn"
                  onClick={() => runCommand(`${panel.extensionId}.drop`, [x])}
                  title={`Drop in column ${x + 1}`}
                >
                  {x + 1}
                </button>
              ))}
            </div>
            <div className="game-connect4-board">
              {rows.map((row, y) => (
                <div key={`c4-row-${y}`} className="game-connect4-row">
                  {row.map((v, x) => (
                    <button
                      key={`c4-${y}-${x}`}
                      type="button"
                      className="game-connect4-cell-btn"
                      onClick={() => runCommand(`${panel.extensionId}.drop`, [x])}
                      title={`Drop in column ${x + 1}`}
                    >
                      <span className={`game-connect4-disc ${v === 1 ? "game-connect4-disc-r" : v === 2 ? "game-connect4-disc-y" : "game-connect4-disc-e"}`} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="game-connect4-turn">Turn: {turn === 1 ? "Red" : "Yellow"}</div>
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.board-chess-pro") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const flat = typeof stats._chess === "string" ? stats._chess : "";
    const legalRaw = typeof stats._legal === "string" ? stats._legal : "";
    const sel = typeof stats._sel === "string" ? stats._sel : "";
    const canHuman = String(stats._canHumanMove ?? "1") === "1";
    const legal = new Set(legalRaw ? legalRaw.split(";") : []);
    const rows: string[][] = [];
    for (let y = 0; y < 8; y += 1) {
      const row: string[] = [];
      for (let x = 0; x < 8; x += 1) row.push(flat[y * 8 + x] || ".");
      rows.push(row);
    }
    const pieceText: Record<string, string> = { K:"♔", Q:"♕", R:"♖", B:"♗", N:"♘", P:"♙", k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟", ".":"" };
    const files = ["a","b","c","d","e","f","g","h"];
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && <div className="extension-panel-stats">{viewStats.map(([k,v]) => <div key={k} className="extension-panel-stat-item"><span>{k}</span><strong>{String(v)}</strong></div>)}</div>}
          <div className="game-chess-shell">
            <div className="game-chess-files">{files.map((f) => <span key={`f-top-${f}`} className="game-chess-file">{f}</span>)}</div>
            <div className="game-board-chess">
              {rows.map((row, y) => <div key={`chr-${y}`} className="game-board-chess-row">
                <span className="game-chess-rank">{8 - y}</span>
                {row.map((p, x) => {
                  const k = `${x},${y}`;
                  const dark = (x + y) % 2 === 1;
                  const selected = sel === k;
                  const sideClass = p === "." ? "" : (p === p.toUpperCase() ? "game-chess-piece-white" : "game-chess-piece-black");
                  return (
                    <button key={`chc-${y}-${x}`} type="button" className={`game-chess-cell ${dark ? "game-chess-dark" : "game-chess-light"} ${selected ? "game-chess-selected" : ""} ${legal.has(k) ? "game-chess-legal" : ""}`} onClick={() => canHuman && runCommand("game.board-chess-pro.cell", [x, y])} disabled={!canHuman}>
                      <span className={`game-chess-piece ${sideClass}`}>{pieceText[p] || ""}</span>
                    </button>
                  );
                })}
                <span className="game-chess-rank">{8 - y}</span>
              </div>)}
            </div>
            <div className="game-chess-files">{files.map((f) => <span key={`f-bottom-${f}`} className="game-chess-file">{f}</span>)}</div>
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && <div className="extension-panel-actions">{panel.model.actions.map((action, idx) => <button key={`${panel.id}-action-${idx}`} className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={() => runCommand(action.command, action.args)}>{action.label}</button>)}</div>}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.board-shogi-lite") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const payload = typeof stats._shogi === "string" ? stats._shogi : "";
    let parsed: { b: string[]; legal: string[]; sel: { x?: number; y?: number; drop?: boolean; kind?: string } | null; hand?: { b?: Record<string, number>; w?: Record<string, number> } } = { b: [], legal: [], sel: null, hand: { b: {}, w: {} } };
    try { parsed = JSON.parse(payload); } catch {}
    const legalSet = new Set((parsed.legal || []).map((v) => String(v)));
    const selKey = parsed.sel && typeof parsed.sel.x === "number" && typeof parsed.sel.y === "number" ? `${parsed.sel.x},${parsed.sel.y}` : "";
    const pieceText: Record<string, string> = { K:"玉", R:"飛", B:"角", G:"金", S:"銀", N:"桂", L:"香", P:"歩", k:"王", r:"飛", b:"角", g:"金", s:"銀", n:"桂", l:"香", p:"歩", ".":"", "+R":"龍", "+B":"馬", "+S":"全", "+N":"圭", "+L":"杏", "+P":"と", "+r":"龍", "+b":"馬", "+s":"全", "+n":"圭", "+l":"杏", "+p":"と" };
    const viewStats = filterViewStats(stats);
    const handBlack = parsed.hand?.b ?? {};
    const handWhite = parsed.hand?.w ?? {};
    const dropKinds = ["P","L","N","S","G","B","R"];
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && <div className="extension-panel-stats">{viewStats.map(([k,v]) => <div key={k} className="extension-panel-stat-item"><span>{k}</span><strong>{String(v)}</strong></div>)}</div>}
          <div className="game-shogi-hand-row game-shogi-hand-row-top">
            {dropKinds.map((k) => (
              <button key={`w-hand-${k}`} type="button" className="game-shogi-hand-piece game-shogi-piece-white" onClick={() => runCommand("game.board-shogi-lite.drop", [k])}>
                {k}:{Number(handWhite[k] || 0)}
              </button>
            ))}
          </div>
          <div className="game-board-shogi">
            {Array.from({ length: 9 }).map((_, y) => (
              <div key={`sh-row-${y}`} className="game-board-shogi-row">
                {Array.from({ length: 9 }).map((__, x) => {
                  const idx = y * 9 + x;
                  const p = parsed.b[idx] || ".";
                  const key = `${x},${y}`;
                  const selected = selKey === key;
                  const legal = legalSet.has(key);
                  const raw = String(p || ".").replace("+", "");
                  const pieceSide = p === "." ? "" : (raw === raw.toUpperCase() ? "black" : "white");
                  return (
                    <button key={`shc-${y}-${x}`} type="button" className={`game-shogi-cell ${(x + y) % 2 ? "game-shogi-dark" : "game-shogi-light"} ${selected ? "game-shogi-selected" : ""} ${legal ? "game-shogi-legal" : ""} ${pieceSide ? `game-shogi-piece-${pieceSide}` : ""}`} onClick={() => runCommand("game.board-shogi-lite.cell", [x, y])}>
                      {pieceText[p] || ""}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="game-shogi-hand-row">
            {dropKinds.map((k) => (
              <button key={`b-hand-${k}`} type="button" className="game-shogi-hand-piece game-shogi-piece-black" onClick={() => runCommand("game.board-shogi-lite.drop", [k])}>
                {k}:{Number(handBlack[k] || 0)}
              </button>
            ))}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && <div className="extension-panel-actions">{panel.model.actions.map((action, idx) => <button key={`${panel.id}-action-${idx}`} className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={() => runCommand(action.command, action.args)}>{action.label}</button>)}</div>}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.puzzle-puyo-burst") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const enc = typeof stats._puyo === "string" ? stats._puyo : "";
    const rows = enc ? enc.split("/").map((r) => r.split("").map((v) => Number(v) || 0)) : [];
    const viewStats = filterViewStats(stats);
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body">
          <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
          {viewStats.length > 0 && <div className="extension-panel-stats">{viewStats.map(([k,v]) => <div key={k} className="extension-panel-stat-item"><span>{k}</span><strong>{String(v)}</strong></div>)}</div>}
          <div className="game-board-puyo game-board-puyo-glow">
            {rows.map((row, y) => <div key={`pyr-${y}`} className="game-board-puyo-row">{row.map((v, x) => <span key={`pyc-${y}-${x}`} className={`game-puyo-cell game-puyo-${v}`} />)}</div>)}
          </div>
          {panel.model?.items?.[0] && <p className="game-runtime-hint">{panel.model.items[0]}</p>}
          {panel.model?.actions && panel.model.actions.length > 0 && <div className="extension-panel-actions">{panel.model.actions.map((action, idx) => <button key={`${panel.id}-action-${idx}`} className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={() => runCommand(action.command, action.args)}>{action.label}</button>)}</div>}
        </div>
      </div>
    );
  }

  if (panel.extensionId === "game.card-solitaire-klondike") {
    const stats = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const raw = typeof stats._sol === "string" ? stats._sol : "";
    let parsed: { stock?: number; waste?: string; draw?: number; f?: Record<string, number>; tab?: string[][] } = {};
    try { parsed = JSON.parse(raw); } catch {}
    const won = stats.state === "win";
    const solMsg = panel.model?.items?.[0] ?? "";
    return (
      <div className="pane extension-panel-pane">
        {panelHeader}
        <div className="pane-body extension-panel-body" style={{ padding: 0 }}>
          <SolitaireBoard
            parsed={{
              stock: parsed.stock ?? 0,
              waste: parsed.waste ?? "--",
              draw: parsed.draw ?? 1,
              f: parsed.f ?? { S: 0, H: 0, D: 0, C: 0 },
              tab: parsed.tab ?? [],
            }}
            msg={typeof solMsg === "string" ? solMsg : ""}
            won={won}
            runCommand={runCommand}
            extId={panel.extensionId}
          />
        </div>
      </div>
    );
  }

  if (NON_GAME_EXTENSION_IDS.has(panel.extensionId)) {
    const st = (panel.model?.stats ?? {}) as Record<string, string | number>;
    const viewStats = filterViewStats(st);
    const items = panel.model?.items ?? [];
    const extId = panel.extensionId;
    const diffRows = extId === "devtools.diff-notes" ? parseDiffRows(items) : [];
    const apiRows = extId === "devtools.api-status" ? parseApiRows(items) : [];
    const kanbanTodo = items.find((x) => x.startsWith("TODO: "))?.slice(6).split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const kanbanDoing = items.find((x) => x.startsWith("DOING: "))?.slice(7).split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const kanbanDone = items.find((x) => x.startsWith("DONE: "))?.slice(6).split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const calendarRows = items
      .map((line) => line.match(/^\[( |x)\]\s+(\d\d:\d\d)\s+(.+)\s+#(\d+)$/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ done: m[1].toLowerCase() === "x", time: m[2], text: m[3], idx: Math.max(0, Number(m[4]) - 1) }));
    const goalRows = items
      .map((line) => line.match(/^\d+\.\s+(.+)\s+\[(\d+)%\]$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m, idx) => ({ idx, name: m[1], progress: Number(m[2]) || 0 }));
    const blockRows = items
      .map((line) => line.match(/^(\d\d:\d\d-\d\d:\d\d)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m, idx) => ({ idx, range: m[1], title: m[2] }));
    const weeklyWins = (items.find((x) => x.startsWith("Wins: ")) ?? "").replace(/^Wins:\s*/, "").split("|").map((x) => x.trim()).filter(Boolean);
    const weeklyLearns = (items.find((x) => x.startsWith("Learns: ")) ?? "").replace(/^Learns:\s*/, "").split("|").map((x) => x.trim()).filter(Boolean);
    const weeklyNext = (items.find((x) => x.startsWith("Next: ")) ?? "").replace(/^Next:\s*/, "").split("|").map((x) => x.trim()).filter(Boolean);
    const meetingLines = items.slice(1);
    const jsonValid = st.valid === "yes";
    const regexMatches = items.filter((_, i) => { const mIdx = items.indexOf("Matches:"); return mIdx >= 0 && i > mIdx; });
    const regexGroupLine = items.find((x) => x.startsWith("First match groups:")) ?? "";
    const pomoRemaining = String(st.remaining ?? "00:00");
    const pomoRunning = String(st.state) === "running";
    const pomoMode = String(st.mode ?? "focus");
    const pomoCount = Number(st.completed ?? 0);
    const habitDoneToday = String(st.doneToday) === "yes";
    const habitStreak = Number(st.streak ?? 0);
    const habitBest = Number(st.best ?? 0);
    const habitPoints = Number(st.points ?? 0);
    const habitLog = items.filter((x) => x !== "Recent:" && x !== "(empty)");

    const Btn: React.FC<{ label: string; cmd: string; args?: unknown[]; accent?: boolean; small?: boolean; danger?: boolean }> = ({ label, cmd, args, accent, small, danger }) => (
      <button className={`ext-btn${accent ? " ext-btn-accent" : ""}${small ? " ext-btn-sm" : ""}${danger ? " ext-btn-danger" : ""}`} onClick={() => runCommand(cmd, args)}>{label}</button>
    );
    const Section: React.FC<{ title: string; icon: string; children: React.ReactNode }> = ({ title, icon, children }) => (
      <div className="ext-section"><div className="ext-section-head"><span className="ext-section-icon">{icon}</span><span className="ext-section-title">{title}</span></div>{children}</div>
    );

    return (
      <div className="pane extension-panel-pane ext-tool">
        <div className="pane-header ext-tool-header">
          <span className="pane-title">{panel.title}</span>
          {viewStats.length > 0 && <div className="ext-stat-row">{viewStats.map(([k, v]) => <span key={k} className="ext-stat-chip"><span className="ext-stat-k">{k}</span><span className="ext-stat-v">{String(v)}</span></span>)}</div>}
          {onToggleDock && (
            <PanelSettingsDropdown isDockedToEditor={isDockedToEditor} onToggleDock={onToggleDock} />
          )}
        </div>
        <div className="pane-body ext-tool-scroll">

          {extId === "devtools.json-lab" && (<>
            <Section title="JSON Input" icon="{ }">
              <textarea className="ext-code-area" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Paste or edit JSON here..." spellCheck={false} />
              <div className="ext-toolbar">
                <Btn label="⏎ Apply" cmd={`${extId}.setText`} args={[inputA]} accent />
                <Btn label="Format" cmd={`${extId}.format`} />
                <Btn label="Minify" cmd={`${extId}.minify`} />
                <Btn label="Sort Keys" cmd={`${extId}.sort`} />
              </div>
            </Section>
            <div className={`ext-validity-bar ${jsonValid ? "ext-validity-ok" : "ext-validity-err"}`}>
              <span className="ext-validity-dot" />{jsonValid ? "Valid JSON" : "Invalid JSON"}
            </div>
            <Section title="Slot Presets" icon="📦">
              <div className="ext-toolbar">
                <Btn label="Slot 1" cmd={`${extId}.load`} args={[1]} />
                <Btn label="Slot 2" cmd={`${extId}.load`} args={[2]} />
                <Btn label="Slot 3" cmd={`${extId}.load`} args={[3]} />
              </div>
            </Section>
          </>)}

          {extId === "devtools.regex-lab" && (<>
            <Section title="Pattern" icon="/./">
              <div className="ext-regex-input-row">
                <span className="ext-regex-slash">/</span>
                <input className="ext-input ext-regex-pattern" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="pattern" spellCheck={false} />
                <span className="ext-regex-slash">/</span>
                <input className="ext-input ext-regex-flags" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="gi" spellCheck={false} />
                <Btn label="Run" cmd={`${extId}.setPattern`} args={[inputA]} accent />
              </div>
            </Section>
            <Section title="Target Text" icon="📝">
              <textarea className="ext-code-area ext-code-area--sm" value={inputC} onChange={(e) => setInputC(e.target.value)} placeholder="Text to match against..." spellCheck={false} />
              <div className="ext-toolbar">
                <Btn label="Apply Text" cmd={`${extId}.setTarget`} args={[inputC]} accent />
                <Btn label="Dataset" cmd={`${extId}.dataset`} />
                <Btn label="Logs" cmd={`${extId}.logs`} />
              </div>
            </Section>
            <Section title={`Matches (${regexMatches.length})`} icon="🎯">
              {regexGroupLine && <div className="ext-regex-group">{regexGroupLine}</div>}
              <div className="ext-match-list">{regexMatches.length ? regexMatches.map((m, i) => <div key={i} className="ext-match-chip">{m}</div>) : <div className="ext-empty">No matches</div>}</div>
            </Section>
          </>)}

          {extId === "devtools.diff-notes" && (<>
            <Section title="Add Note" icon="📋">
              <div className="ext-row">
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Describe the issue..." />
                <select className="ext-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="high">🔴 High</option>
                  <option value="medium">🟡 Medium</option>
                  <option value="low">🟢 Low</option>
                </select>
                <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA || "note", priority]} accent />
              </div>
              <div className="ext-row">
                <span className="ext-search-icon">🔍</span>
                <input className="ext-input ext-input-grow" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="Filter notes..." />
                <Btn label="Search" cmd={`${extId}.search`} args={[inputB]} />
                <Btn label="Clear All" cmd={`${extId}.clear`} danger small />
              </div>
            </Section>
            <div className="ext-note-list">
              {diffRows.length === 0 && <div className="ext-empty">No notes yet. Add one above.</div>}
              {diffRows.map((row) => (
                <div key={`diff-${row.idx}`} className={`ext-note-card ${row.done ? "ext-note-done" : ""} ext-note-${row.priority}`}>
                  <button className="ext-note-check" onClick={() => runCommand(`${extId}.toggle`, [row.idx])}>{row.done ? "✓" : ""}</button>
                  <div className="ext-note-body">
                    <span className={`ext-pri-dot ext-pri-${row.priority}`} />
                    <span className="ext-note-text">{row.text}</span>
                  </div>
                  <button className="ext-note-del" onClick={() => runCommand(`${extId}.remove`, [row.idx])}>×</button>
                </div>
              ))}
            </div>
          </>)}

          {extId === "devtools.api-status" && (<>
            <Section title="Add Endpoint" icon="🌐">
              <div className="ext-row">
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="/api/endpoint" />
                <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA]} accent />
                <Btn label="↻ Refresh" cmd={`${extId}.refresh`} />
                <Btn label="Reset" cmd={`${extId}.reset`} small />
              </div>
            </Section>
            <div className="ext-api-grid">
              {apiRows.map((row) => (
                <div key={`api-${row.name}`} className={`ext-api-card ${row.ok ? "" : "ext-api-card--down"}`}>
                  <div className="ext-api-card-head">
                    <span className={`ext-api-dot ${row.ok ? "ext-api-dot--up" : "ext-api-dot--down"}`} />
                    <span className="ext-api-name">{row.name}</span>
                    <button className="ext-note-del" onClick={() => runCommand(`${extId}.remove`, [row.name])}>×</button>
                  </div>
                  <div className="ext-api-metrics">
                    <span>{row.latency}<small>ms</small></span>
                    <span className={row.fail > 0 ? "ext-api-fail" : ""}>{row.fail} fail{row.fail !== 1 ? "s" : ""}</span>
                  </div>
                </div>
              ))}
            </div>
          </>)}

          {extId === "productivity.pomodoro" && (<>
            <div className={`ext-pomo-ring ${pomoRunning ? "ext-pomo-ring--active" : ""}`}>
              <div className="ext-pomo-mode">{pomoMode === "focus" ? "🔥 FOCUS" : "☕ BREAK"}</div>
              <div className="ext-pomo-timer">{pomoRemaining}</div>
              <div className="ext-pomo-count">{pomoCount} session{pomoCount !== 1 ? "s" : ""} done</div>
            </div>
            <div className="ext-toolbar ext-toolbar-center">
              <Btn label={pomoRunning ? "⏸ Pause" : "▶ Start"} cmd={`${extId}.toggle`} accent />
              <Btn label="↺ Reset" cmd={`${extId}.reset`} />
            </div>
            <div className="ext-toolbar ext-toolbar-center">
              <Btn label="Focus 25m" cmd={`${extId}.set`} args={[25, "focus"]} small />
              <Btn label="Deep 50m" cmd={`${extId}.set`} args={[50, "focus"]} small />
              <Btn label="Break 5m" cmd={`${extId}.set`} args={[5, "break"]} small />
              <Btn label="Break 15m" cmd={`${extId}.set`} args={[15, "break"]} small />
            </div>
          </>)}

          {extId === "productivity.kanban-lite" && (<>
            <Section title="Add Task" icon="📌">
              <div className="ext-row">
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Task name..." onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runCommand(`${extId}.add`, [inputA || "Task"]); setInputA(""); } }} />
                <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA || "Task"]} accent />
              </div>
            </Section>
            <div className="ext-kanban">
              <div className="ext-kanban-col ext-kanban-todo"><div className="ext-kanban-head">TODO <span className="ext-kanban-cnt">{kanbanTodo.length}</span></div>{kanbanTodo.map((v, i) => <div key={`todo-${i}`} className="ext-kanban-card">{v}</div>)}</div>
              <div className="ext-kanban-col ext-kanban-doing"><div className="ext-kanban-head">DOING <span className="ext-kanban-cnt">{kanbanDoing.length}</span></div>{kanbanDoing.map((v, i) => <div key={`doing-${i}`} className="ext-kanban-card">{v}</div>)}</div>
              <div className="ext-kanban-col ext-kanban-done"><div className="ext-kanban-head">DONE <span className="ext-kanban-cnt">{kanbanDone.length}</span></div>{kanbanDone.map((v, i) => <div key={`done-${i}`} className="ext-kanban-card ext-kanban-card--done">{v}</div>)}</div>
            </div>
            <div className="ext-toolbar ext-toolbar-center">
              <Btn label="▶ Start Next" cmd={`${extId}.start`} accent />
              <Btn label="✓ Finish" cmd={`${extId}.finish`} />
              <Btn label="◀ Back" cmd={`${extId}.back`} />
              <Btn label="🗑 Clear Done" cmd={`${extId}.clearDone`} danger small />
            </div>
          </>)}

          {extId === "productivity.scratchpad" && (<>
            <Section title={`Doc: ${String(st.doc ?? "default")}`} icon="📝">
              <textarea className="ext-code-area" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Write anything here..." spellCheck={false} />
              <div className="ext-toolbar">
                <Btn label="💾 Save" cmd={`${extId}.setDocLines`} args={[inputA]} accent />
                <Btn label="⏱ Timestamp" cmd={`${extId}.add`} />
                <Btn label="📄 Next Doc" cmd={`${extId}.nextDoc`} />
                <Btn label="+ New Doc" cmd={`${extId}.newDoc`} args={[`notes-${new Date().toLocaleDateString()}`]} />
                <Btn label="🗑 Clear" cmd={`${extId}.clear`} danger small />
              </div>
            </Section>
            <div className="ext-stat-row">{[["docs", st.docs], ["lines", st.lines], ["tags", st.tags]].map(([k, v]) => <span key={String(k)} className="ext-stat-chip"><span className="ext-stat-k">{String(k)}</span><span className="ext-stat-v">{String(v ?? "-")}</span></span>)}</div>
          </>)}

          {extId === "productivity.habit-tracker" && (<>
            <div className="ext-habit-hero">
              <div className="ext-habit-score">{habitPoints}</div>
              <div className="ext-habit-label">points</div>
              <div className="ext-habit-meta">
                <span className="ext-stat-chip"><span className="ext-stat-k">streak</span><span className="ext-stat-v">{habitStreak}d</span></span>
                <span className="ext-stat-chip"><span className="ext-stat-k">best</span><span className="ext-stat-v">{habitBest}d</span></span>
                <span className={`ext-stat-chip ${habitDoneToday ? "ext-stat-chip--ok" : ""}`}><span className="ext-stat-k">today</span><span className="ext-stat-v">{habitDoneToday ? "✓" : "—"}</span></span>
              </div>
            </div>
            <div className="ext-toolbar ext-toolbar-center">
              <Btn label="✓ Done Today" cmd={`${extId}.inc`} args={[1]} accent />
              <Btn label="+7 Weekly" cmd={`${extId}.inc`} args={[7]} />
              <Btn label="↺ Reset" cmd={`${extId}.reset`} danger small />
            </div>
            {habitLog.length > 0 && <Section title="Recent Log" icon="📅">{habitLog.map((l, i) => <div key={i} className="ext-log-line">{l}</div>)}</Section>}
          </>)}

          {extId === "productivity.calendar-planner" && (() => {
            const gridLine = items.find((x) => x.startsWith("GRID:"));
            const cells = gridLine ? gridLine.slice(5).split(",") : [];
            const selLine = items.find((x) => x.startsWith("SEL:"));
            const selKey = selLine ? selLine.slice(4) : "";
            const todayKey = String(st.today ?? "");
            const selEvents = items.filter((x) => /^\[[ x]\]\s+\d\d:\d\d/.test(x));
            const selEvParsed = selEvents.map((line, idx) => {
              const m = line.match(/^\[( |x)\]\s+(\d\d:\d\d)\s+(.+)\s+#(\d+)$/i);
              if (!m) return null;
              return { done: m[1] === "x", time: m[2], text: m[3], idx: Math.max(0, Number(m[4]) - 1) };
            }).filter((x): x is { done: boolean; time: string; text: string; idx: number } => !!x);
            const dayHeaders = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            return (<>
              <div className="ext-cal-nav">
                <Btn label="◀" cmd={`${extId}.prevMonth`} small />
                <Btn label="Today" cmd={`${extId}.goToday`} small />
                <Btn label="▶" cmd={`${extId}.nextMonth`} small />
              </div>
              <div className="ext-cal-grid">
                {dayHeaders.map((d) => <div key={d} className="ext-cal-dow">{d}</div>)}
                {cells.map((cell, ci) => {
                  if (cell === "_") return <div key={`blank-${ci}`} className="ext-cal-cell ext-cal-blank" />;
                  const isToday = cell.startsWith("T");
                  const rest = isToday ? cell.slice(1) : cell;
                  const parts = rest.split(":");
                  const dayNum = parts[0];
                  const evCount = parts[1] ? Number(parts[1]) : 0;
                  const cellKey = `${st.year}-${String(Number(st.month)).padStart(2, "0")}-${dayNum.padStart(2, "0")}`;
                  const isSel = cellKey === selKey;
                  return (
                    <div
                      key={`c-${ci}`}
                      className={`ext-cal-cell${isToday ? " ext-cal-today" : ""}${isSel ? " ext-cal-sel" : ""}${evCount ? " ext-cal-has-ev" : ""}`}
                      onClick={() => runCommand(`${extId}.selectDate`, [cellKey])}
                    >
                      <span className="ext-cal-day">{dayNum}</span>
                      {evCount > 0 && <span className="ext-cal-dot">{evCount}</span>}
                    </div>
                  );
                })}
              </div>
              <Section title={`Events — ${selKey}`} icon="📋">
                <div className="ext-row">
                  <input className="ext-input" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="HH:MM" style={{ maxWidth: "5.5rem" }} />
                  <input className="ext-input ext-input-grow" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="Event title" />
                  <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA || "09:00", inputB || "Event"]} accent />
                </div>
              </Section>
              <div className="ext-event-list">
                {selEvParsed.length === 0 && <div className="ext-empty">No events on this date.</div>}
                {selEvParsed.map((row) => (
                  <div key={`cal-${row.idx}`} className={`ext-event-card ${row.done ? "ext-event-done" : ""}`}>
                    <button className="ext-note-check" onClick={() => runCommand(`${extId}.toggle`, [row.idx])}>{row.done ? "✓" : ""}</button>
                    <span className="ext-event-time">{row.time}</span>
                    <span className="ext-event-text">{row.text}</span>
                    <button className="ext-note-del" onClick={() => runCommand(`${extId}.remove`, [row.idx])}>×</button>
                  </div>
                ))}
              </div>
            </>);
          })()}

          {extId === "productivity.goal-tracker-pro" && (<>
            <Section title="Goals" icon="🎯">
              <div className="ext-row">
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Goal name..." />
                <Btn label="+ Add Goal" cmd={`${extId}.add`} args={[inputA || "Goal"]} accent />
                <Btn label="Archive 100%" cmd={`${extId}.archive`} small />
              </div>
            </Section>
            <div className="ext-goal-list">
              {goalRows.length === 0 && <div className="ext-empty">No goals. Add one above.</div>}
              {goalRows.map((row) => (
                <div key={`goal-${row.idx}`} className="ext-goal-card">
                  <div className="ext-goal-top"><span>{row.name}</span><strong className="ext-goal-pct">{row.progress}%</strong></div>
                  <div className="ext-goal-track"><div className="ext-goal-fill" style={{ width: `${row.progress}%` }} /></div>
                  <div className="ext-toolbar">
                    <Btn label="+10" cmd={`${extId}.inc`} args={[row.idx, 10]} small />
                    <Btn label="−10" cmd={`${extId}.inc`} args={[row.idx, -10]} small />
                    <Btn label="×" cmd={`${extId}.remove`} args={[row.idx]} danger small />
                  </div>
                </div>
              ))}
            </div>
          </>)}

          {extId === "productivity.time-blocker" && (<>
            <Section title={`Focus Blocks (${String(st.focusHours ?? "0m")})`} icon="⏱">
              <div className="ext-row">
                <input className="ext-input" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="09:00-10:30" style={{ maxWidth: "9rem" }} />
                <input className="ext-input ext-input-grow" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="Task" />
                <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA || "09:00-10:00", inputB || "Focus"]} accent />
                <Btn label="Sort" cmd={`${extId}.sort`} small />
              </div>
            </Section>
            <div className="ext-block-list">
              {blockRows.length === 0 && <div className="ext-empty">No blocks. Add one above.</div>}
              {blockRows.map((row) => (
                <div key={`block-${row.idx}`} className="ext-block-card">
                  <span className="ext-block-range">{row.range}</span>
                  <span className="ext-block-title">{row.title}</span>
                  <button className="ext-note-del" onClick={() => runCommand(`${extId}.remove`, [row.idx])}>×</button>
                </div>
              ))}
            </div>
          </>)}

          {extId === "productivity.weekly-review" && (<>
            <Section title="Weekly Review" icon="📊">
              <div className="ext-row">
                <select className="ext-select" value={weeklyType} onChange={(e) => setWeeklyType(e.target.value)}>
                  <option value="wins">🏆 Win</option>
                  <option value="learns">💡 Learn</option>
                  <option value="next">🚀 Next</option>
                </select>
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Add item..." />
                <Btn label="+ Add" cmd={`${extId}.addTyped`} args={[weeklyType, inputA]} accent />
                <Btn label="Summary" cmd={`${extId}.summary`} small />
              </div>
            </Section>
            <div className="ext-kanban">
              <div className="ext-kanban-col ext-kanban-wins"><div className="ext-kanban-head">🏆 Wins <span className="ext-kanban-cnt">{weeklyWins.length}</span></div>{weeklyWins.map((v, i) => <div key={`ww-${i}`} className="ext-kanban-card">{v}</div>)}</div>
              <div className="ext-kanban-col ext-kanban-learns"><div className="ext-kanban-head">💡 Learns <span className="ext-kanban-cnt">{weeklyLearns.length}</span></div>{weeklyLearns.map((v, i) => <div key={`wl-${i}`} className="ext-kanban-card">{v}</div>)}</div>
              <div className="ext-kanban-col ext-kanban-next"><div className="ext-kanban-head">🚀 Next <span className="ext-kanban-cnt">{weeklyNext.length}</span></div>{weeklyNext.map((v, i) => <div key={`wn-${i}`} className="ext-kanban-card">{v}</div>)}</div>
            </div>
          </>)}

          {extId === "productivity.meeting-notes" && (<>
            <Section title={`Meeting: ${String(st.meeting ?? "Sync")}`} icon="🗓">
              <div className="ext-row">
                <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Add line..." onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runCommand(`${extId}.append`, [inputA]); setInputA(""); } }} />
                <Btn label="+ Append" cmd={`${extId}.append`} args={[inputA]} accent />
                <Btn label="⏱ Time" cmd={`${extId}.add`} />
              </div>
              <div className="ext-toolbar">
                <Btn label="📄 Next Meeting" cmd={`${extId}.nextMeeting`} />
                <Btn label="+ New" cmd={`${extId}.newMeeting`} args={[`Meeting ${new Date().toLocaleDateString()}`]} />
                <Btn label="📋 Template" cmd={`${extId}.template`} />
                <Btn label="🗑 Clear" cmd={`${extId}.clear`} danger small />
              </div>
            </Section>
            <div className="ext-meeting-list">
              {meetingLines.length === 0 && <div className="ext-empty">Empty. Add lines above.</div>}
              {meetingLines.map((line, idx) => (
                <div key={`mn-${idx}`} className="ext-meeting-line">
                  <span className="ext-meeting-bullet">•</span>
                  <span className="ext-meeting-text">{line}</span>
                  <button className="ext-note-del" onClick={() => runCommand(`${extId}.remove`, [idx])}>×</button>
                </div>
              ))}
            </div>
          </>)}

          {extId === "productivity.notion-notes" && (() => {
            const pagesStart = items.indexOf("PAGES:");
            const blocksStart = items.indexOf("BLOCKS:");
            const pageLines = pagesStart >= 0 && blocksStart >= 0 ? items.slice(pagesStart + 1, blocksStart) : [];
            const blockLines = blocksStart >= 0 ? items.slice(blocksStart + 1) : [];
            const parsedPages = pageLines.map((line, idx) => {
              const active = line.startsWith(">");
              const pinned = line.includes("★");
              const text = line.replace(/^[> ]+/, "").replace(/★\s*/, "").trim();
              return { idx, active, pinned, text };
            });
            const parsedBlocks = blockLines.map((line) => {
              const parts = line.split("|");
              const type = parts[0];
              const idx = Number(parts[1]) || 0;
              if (type === "TODO") return { type, idx, done: parts[2] === "1", text: parts.slice(3).join("|") };
              if (type === "DIVIDER") return { type, idx, done: false, text: "" };
              return { type, idx, done: false, text: parts.slice(2).join("|") };
            });
            return (<>
              <div className="ext-notion-sidebar">
                <div className="ext-notion-pages">
                  {parsedPages.map((p) => (
                    <div key={`np-${p.idx}`} className={`ext-notion-page-row${p.active ? " ext-notion-page-active" : ""}`} onClick={() => runCommand(`${extId}.selectPage`, [p.idx])}>
                      <span className="ext-notion-page-text">{p.text}</span>
                      {p.pinned && <span className="ext-notion-pin">📌</span>}
                    </div>
                  ))}
                </div>
                <div className="ext-toolbar">
                  <Btn label="+ Page" cmd={`${extId}.newPage`} args={[inputA || "Untitled", "📄"]} accent small />
                  <Btn label="📌 Pin" cmd={`${extId}.togglePin`} small />
                  <Btn label="📋 Dup" cmd={`${extId}.duplicatePage`} small />
                  <Btn label="🗑" cmd={`${extId}.deletePage`} danger small />
                </div>
              </div>
              <div className="ext-notion-editor">
                {parsedBlocks.map((b) => {
                  if (b.type === "DIVIDER") return <hr key={`nb-${b.idx}`} className="ext-notion-divider" />;
                  if (b.type === "H1") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-h1">{b.text}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  if (b.type === "H2") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-h2">{b.text}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  if (b.type === "H3") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-h3">{b.text}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  if (b.type === "TODO") return (
                    <div key={`nb-${b.idx}`} className={`ext-notion-block ext-notion-todo${b.done ? " ext-notion-todo-done" : ""}`}>
                      <button className="ext-note-check" onClick={() => runCommand(`${extId}.toggleTodo`, [b.idx])}>{b.done ? "✓" : ""}</button>
                      <span>{b.text}</span>
                      <button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button>
                    </div>
                  );
                  if (b.type === "BULLET") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-bullet"><span className="ext-meeting-bullet">•</span>{b.text}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  if (b.type === "QUOTE") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-quote">{b.text}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  if (b.type === "CODE") return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-code"><code>{b.text}</code><button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                  return <div key={`nb-${b.idx}`} className="ext-notion-block ext-notion-p">{b.text || "\u00A0"}<button className="ext-note-del" onClick={() => runCommand(`${extId}.removeBlock`, [b.idx])}>×</button></div>;
                })}
              </div>
              <div className="ext-notion-cmd-bar">
                <input className="ext-input ext-input-grow ext-notion-cmd-input" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Type text, or use / commands: /todo /h1 /h2 /h3 /bullet /quote /code /divider  —  or  # ## ### > - []" onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const raw = inputA;
                    let type = "p";
                    let text = raw;
                    if (raw.startsWith("/todo ") || raw === "/todo") { type = "todo"; text = raw.replace(/^\/todo\s*/, ""); }
                    else if (raw.startsWith("/h1 ") || raw === "/h1") { type = "h1"; text = raw.replace(/^\/h1\s*/, ""); }
                    else if (raw.startsWith("/h2 ") || raw === "/h2") { type = "h2"; text = raw.replace(/^\/h2\s*/, ""); }
                    else if (raw.startsWith("/h3 ") || raw === "/h3") { type = "h3"; text = raw.replace(/^\/h3\s*/, ""); }
                    else if (raw.startsWith("/bullet ") || raw === "/bullet") { type = "bullet"; text = raw.replace(/^\/bullet\s*/, ""); }
                    else if (raw.startsWith("/quote ") || raw === "/quote") { type = "quote"; text = raw.replace(/^\/quote\s*/, ""); }
                    else if (raw.startsWith("/code ") || raw === "/code") { type = "code"; text = raw.replace(/^\/code\s*/, ""); }
                    else if (raw === "/divider" || raw === "/hr" || raw === "---") { type = "divider"; text = ""; }
                    else if (raw.startsWith("### ")) { type = "h3"; text = raw.slice(4); }
                    else if (raw.startsWith("## ")) { type = "h2"; text = raw.slice(3); }
                    else if (raw.startsWith("# ")) { type = "h1"; text = raw.slice(2); }
                    else if (raw.startsWith("> ")) { type = "quote"; text = raw.slice(2); }
                    else if (raw.startsWith("- ")) { type = "bullet"; text = raw.slice(2); }
                    else if (raw.startsWith("[] ") || raw.startsWith("[ ] ")) { type = "todo"; text = raw.replace(/^\[[ ]?\]\s*/, ""); }
                    runCommand(`${extId}.addBlock`, [type, text]);
                    setInputA("");
                  }
                }} />
                <div className="ext-notion-cmd-hints">
                  <span className="ext-notion-hint">/todo</span>
                  <span className="ext-notion-hint">/h1</span>
                  <span className="ext-notion-hint">/h2</span>
                  <span className="ext-notion-hint">#</span>
                  <span className="ext-notion-hint">&gt;</span>
                  <span className="ext-notion-hint">-</span>
                  <span className="ext-notion-hint">[]</span>
                  <span className="ext-notion-hint">/code</span>
                  <span className="ext-notion-hint">---</span>
                </div>
              </div>
            </>);
          })()}

          {extId === "productivity.paper-manager" && (() => {
            const tagsLine = items.find((x) => x.startsWith("TAGS:"));
            const allTags = tagsLine ? tagsLine.slice(5).split(",").filter(Boolean) : [];
            const filterTagLine = items.find((x) => x.startsWith("FILTER_TAG:"));
            const currentFilterTag = filterTagLine ? filterTagLine.slice(11) : "";
            const filterStatusLine = items.find((x) => x.startsWith("FILTER_STATUS:"));
            const currentFilterStatus = filterStatusLine ? filterStatusLine.slice(14) : "";
            const sortLine = items.find((x) => x.startsWith("SORT:"));
            const currentSort = sortLine ? sortLine.slice(5) : "addedAt";
            const paperJsonLines = items.filter((x) => x.startsWith("PJ:"));
            const parsedPapers = paperJsonLines.map((line) => {
              try { const p = JSON.parse(line.slice(3)); return { id: Number(p.id), status: String(p.status || "unread"), rating: Number(p.rating || 0), year: Number(p.year || 0), authors: String(p.authors || ""), title: String(p.title || "Untitled"), venue: String(p.venue || ""), tags: Array.isArray(p.tags) ? p.tags.map(String) : [], notes: String(p.notes || ""), hasPdf: !!p.hasPdf }; } catch { return null; }
            }).filter(Boolean) as Array<{ id: number; status: string; rating: number; year: number; authors: string; title: string; venue: string; tags: string[]; notes: string; hasPdf: boolean }>;
            const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
            return (<>
              <div className="ext-paper-filters">
                <select className="ext-select" value={currentFilterStatus} onChange={(e) => runCommand(`${extId}.filterStatus`, [e.target.value])}>
                  <option value="">All Status</option>
                  <option value="unread">📕 Unread</option>
                  <option value="reading">📖 Reading</option>
                  <option value="read">📗 Read</option>
                </select>
                <select className="ext-select" value={currentFilterTag} onChange={(e) => runCommand(`${extId}.filterTag`, [e.target.value])}>
                  <option value="">All Tags</option>
                  {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="ext-select" value={currentSort} onChange={(e) => runCommand(`${extId}.sort`, [e.target.value])}>
                  <option value="addedAt">Recently Added</option>
                  <option value="year">Year ↓</option>
                  <option value="rating">Rating ↓</option>
                  <option value="title">Title A-Z</option>
                </select>
              </div>
              <Section title="Add Paper" icon="📚">
                <div className="ext-row">
                  <input className="ext-input ext-input-grow" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="Title" />
                  <input className="ext-input" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="Authors" style={{ maxWidth: "10rem" }} />
                  <input className="ext-input" value={inputC} onChange={(e) => setInputC(e.target.value)} placeholder="Year" style={{ maxWidth: "4.5rem" }} />
                  <Btn label="+ Add" cmd={`${extId}.add`} args={[inputA, inputB, inputC, ""]} accent />
                </div>
              </Section>
              <div className="ext-paper-body">
                <div className="ext-paper-list">
                  {parsedPapers.length === 0 && <div className="ext-empty">No papers match filters.</div>}
                  {parsedPapers.map((paper) => {
                    const isSel = selectedPaperId === paper.id;
                    return (
                      <div key={`paper-${paper.id}`} className={`ext-paper-card ext-paper-${paper.status}${isSel ? " ext-paper-selected" : ""}`} onClick={() => { setSelectedPaperId(isSel ? null : paper.id); setPaperNoteEdit(paper.notes || ""); }}>
                        <div className="ext-paper-head">
                          <span className={`ext-paper-status ext-paper-st-${paper.status}`}>{paper.status === "read" ? "📗" : paper.status === "reading" ? "📖" : "📕"}</span>
                          <span className="ext-paper-title">{paper.title}</span>
                          <button className="ext-note-del" onClick={(e) => { e.stopPropagation(); runCommand(`${extId}.remove`, [paper.id]); if (isSel) setSelectedPaperId(null); }}>×</button>
                        </div>
                        <div className="ext-paper-meta">
                          <span>{paper.authors}</span>
                          <span>{paper.year > 0 ? paper.year : ""}</span>
                          <span className="ext-paper-rating" onClick={(e) => { e.stopPropagation(); runCommand(`${extId}.setRating`, [paper.id, paper.rating >= 5 ? 0 : paper.rating + 1]); }}>{stars(paper.rating)}</span>
                        </div>
                        <div className="ext-paper-tags">
                          {paper.tags.map((t) => <span key={t} className="ext-paper-tag">{t}</span>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const sel = parsedPapers.find((p) => p.id === selectedPaperId);
                  if (!sel) return <div className="ext-paper-detail ext-paper-detail-empty"><div className="ext-paper-detail-placeholder">← Select a paper to view details</div></div>;
                  return (
                    <div className="ext-paper-detail">
                      <div className="ext-paper-detail-header">
                        <h3>{sel.title}</h3>
                        <div className="ext-paper-detail-meta">
                          {sel.authors && <span className="ext-paper-detail-authors">{sel.authors}</span>}
                          {sel.year > 0 && <span className="ext-paper-detail-year">{sel.year}</span>}
                          {sel.venue && <span className="ext-paper-detail-venue">{sel.venue}</span>}
                        </div>
                        <div className="ext-paper-detail-status-row">
                          <select className="ext-select" value={sel.status} onChange={(e) => runCommand(`${extId}.setStatus`, [sel.id, e.target.value])}>
                            <option value="unread">Unread</option>
                            <option value="reading">Reading</option>
                            <option value="read">Read</option>
                          </select>
                          <span className="ext-paper-rating" onClick={() => runCommand(`${extId}.setRating`, [sel.id, sel.rating >= 5 ? 0 : sel.rating + 1])}>{stars(sel.rating)}</span>
                        </div>
                      </div>
                      <div className="ext-paper-detail-tags">
                        {sel.tags.map((t) => <span key={t} className="ext-paper-tag" onClick={() => runCommand(`${extId}.removeTag`, [sel.id, t])} title="Click to remove">{t} ×</span>)}
                        <input className="ext-input ext-paper-tag-input" placeholder="+ add tag" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) { runCommand(`${extId}.addTag`, [sel.id, (e.target as HTMLInputElement).value.trim()]); (e.target as HTMLInputElement).value = ""; } }} />
                      </div>
                      <div className="ext-paper-detail-actions">
                        {sel.hasPdf ? (
                          <>
                            <button className="ext-btn ext-btn-sm ext-paper-btn-view" onClick={() => handleViewPdf(sel.id)}>
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2h8l4 4v8H2V2z" stroke="currentColor" strokeWidth="1.3"/><path d="M10 2v4h4" stroke="currentColor" strokeWidth="1.3"/></svg>
                              View PDF
                            </button>
                            <button className={`ext-btn ext-btn-sm ext-paper-btn-ai${aiExtracting === sel.id ? " ext-paper-btn-ai--busy" : ""}`} disabled={aiExtracting === sel.id} onClick={() => handleAiExtract(sel.id)}>
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 6.5C5.5 5.67 6.34 5 7.5 5h1c1.16 0 2 .67 2 1.5S9.66 8 8.5 8H7.5v1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor"/></svg>
                              {aiExtracting === sel.id ? "Analyzing..." : "AI Extract"}
                            </button>
                            <button className="ext-btn ext-btn-sm ext-paper-btn-detach" onClick={() => runCommand(`${extId}.removePdf`, [sel.id])}>
                              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                              Remove PDF
                            </button>
                          </>
                        ) : (
                          <button className="ext-btn ext-btn-sm ext-paper-btn-attach" onClick={() => { setPdfTargetId(sel.id); setTimeout(() => pdfInputRef.current?.click(), 0); }}>
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4.5 7.5l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 12v2h12v-2" stroke="currentColor" strokeWidth="1.3"/></svg>
                            Attach PDF
                          </button>
                        )}
                      </div>
                      <div className="ext-paper-detail-notes">
                        <div className="ext-paper-detail-notes-label">Notes / AI Summary</div>
                        <textarea
                          className="ext-paper-notes-editor"
                          value={paperNoteEdit}
                          onChange={(e) => setPaperNoteEdit(e.target.value)}
                          onFocus={() => { paperNoteEditorFocused.current = true; }}
                          onBlur={() => { paperNoteEditorFocused.current = false; if (paperNoteEdit !== (sel.notes || "")) pmExec("setNotes", [sel.id, paperNoteEdit]); }}
                          placeholder="Write notes here or use AI Extract to auto-fill..."
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>
              <input ref={pdfInputRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={handlePdfSelect} />
            </>);
          })()}
        </div>
      </div>
    );
  }

  return (
    <div className="pane extension-panel-pane">
      {panelHeader}
      <div className="pane-body extension-panel-body">
        <pre className="extension-panel-markdown">{panel.model?.markdown ?? "(empty panel content)"}</pre>
        {panel.model?.stats && (
          <div className="extension-panel-stats">
            {Object.entries(panel.model.stats)
              .filter(([k]) => !k.startsWith("_"))
              .map(([k, v]) => (
              <div key={k} className="extension-panel-stat-item">
                <span>{k}</span>
                <strong>{String(v)}</strong>
              </div>
            ))}
          </div>
        )}
        {panel.model?.items && panel.model.items.length > 0 && (
          <div className="extension-panel-items">
            {panel.model.items.map((item, idx) => (
              <pre key={`${panel.id}-${idx}`} className="extension-panel-item-line">{item}</pre>
            ))}
          </div>
        )}
        {panel.model?.actions && panel.model.actions.length > 0 && (
          <div className="extension-panel-actions">
            {panel.model.actions.map((action, idx) => (
              <button
                key={`${panel.id}-action-${idx}`}
                className="icon-button"
                style={{ width: "auto", padding: "0 0.6rem" }}
                onClick={() => runCommand(action.command, action.args)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
