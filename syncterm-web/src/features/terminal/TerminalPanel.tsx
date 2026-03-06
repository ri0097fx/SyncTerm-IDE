import React, { useEffect, useRef, useState } from "react";
import { useSession } from "../session/SessionContext";
import type { TerminalLine } from "../../types/domain";
import { api } from "../../lib/api";
import { usePreferences } from "../preferences/PreferencesContext";

const MAX_TERMINAL_LINES = 5000;

export const TerminalPanel: React.FC = () => {
  const { preferences } = usePreferences();
  const { currentWatcher, currentSession } = useSession();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"Remote" | "Local">("Remote");
  const [autoScroll, setAutoScroll] = useState(true);
  const [promptText, setPromptText] = useState("[Remote] $");
  const [promptFullCwd, setPromptFullCwd] = useState<string | null>(null);
  const [currentDirPath, setCurrentDirPath] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingLogLinesRef = useRef<TerminalLine[]>([]);

  // 初期ログ（失敗時も UI は維持）
  useEffect(() => {
    if (!currentWatcher || !currentSession || mode !== "Remote") {
      setLines([]);
      setPromptText(mode === "Local" ? "[Local] $" : "[Remote] $");
      return;
    }
    setLines([]);
    setPromptText("[Remote] $");
    const load = async () => {
      if (!currentWatcher || !currentSession) return;
      try {
        const init = await api.getInitialLog(currentWatcher.id, currentSession.name);
        setLines(Array.isArray(init) ? init : []);
      } catch {
        setLines([]);
      }
      try {
        const st = await api.getWatcherStatus(currentWatcher.id, currentSession.name);
        const env = st?.condaEnv && st.condaEnv !== "base" ? `(${st.condaEnv}) ` : "";
        const user = st?.user ?? "";
        const host = st?.host ?? "";
        const pathDisplay = st?.cwd ?? "";
        const p = `${env}${user}@${host}:${pathDisplay}$`.trim();
        setPromptText(p || "[Remote] $");
        setPromptFullCwd((st?.fullCwd && st.fullCwd.trim()) ? st.fullCwd : null);
        const cwdRaw = (st?.cwd ?? "").trim().replace(/^\.\/?/, "") || "";
        setCurrentDirPath(cwdRaw);
      } catch {
        setPromptText("[Remote] $");
        setPromptFullCwd(null);
        setCurrentDirPath("");
      }
    };
    void load();
  }, [currentWatcher, currentSession, mode]);

  // 疑似ポーリング（失敗時は握りつぶし、UI が落ちないようにする）
  useEffect(() => {
    if (!currentWatcher || !currentSession || mode !== "Remote") return;

    let cancelled = false;
    const tick = async () => {
      if (!currentWatcher || !currentSession || cancelled) return;
      try {
        const all = await api.fetchLogTail(currentWatcher.id, currentSession.name);
        if (!cancelled && all.length > 0) {
          const maxLines = Math.max(500, Number(preferences?.terminalMaxLines) || 5000);
          const sel = document.getSelection();
          const selectionInLog =
            logRef.current &&
            sel?.anchorNode &&
            logRef.current.contains(sel.anchorNode) &&
            (sel.toString()?.length ?? 0) > 0;
          if (selectionInLog) {
            pendingLogLinesRef.current = [...pendingLogLinesRef.current, ...all];
          } else {
            const pending = pendingLogLinesRef.current;
            pendingLogLinesRef.current = [];
            setLines((prev) => [...prev, ...pending, ...all].slice(-maxLines));
          }
        }
      } catch {
        // 404 / ネットワークエラー等で落とさない
      }
      const pollMs = Math.max(200, Number(preferences?.terminalPollMs) || 1000);
      if (!cancelled) setTimeout(tick, pollMs);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [currentWatcher, currentSession, mode, preferences.terminalMaxLines, preferences.terminalPollMs]);

  useEffect(() => {
    const el = logRef.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  // Keep prompt updated (poll status). On error or empty, keep current or fallback to [Remote] $.
  useEffect(() => {
    if (!currentWatcher || !currentSession || mode !== "Remote") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const st = await api.getWatcherStatus(currentWatcher.id, currentSession.name);
        if (cancelled) return;
        const env = st?.condaEnv && st.condaEnv !== "base" ? `(${st.condaEnv}) ` : "";
        const user = st?.user ?? "";
        const host = st?.host ?? "";
        const pathDisplay = st?.cwd ?? "";
        const p = `${env}${user}@${host}:${pathDisplay}$`.trim();
        setPromptText(p || "[Remote] $");
        if (!cancelled) setPromptFullCwd((st?.fullCwd && st.fullCwd.trim()) ? st.fullCwd : null);
        if (!cancelled) setCurrentDirPath(((st?.cwd ?? "").trim().replace(/^\.\/?/, "") || ""));
      } catch {
        if (!cancelled) setPromptText("[Remote] $");
        if (!cancelled) setPromptFullCwd(null);
        if (!cancelled) setCurrentDirPath("");
      }
      if (!cancelled) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [currentWatcher, currentSession, mode]);

  const handleTabComplete = React.useCallback(async () => {
    if (!currentWatcher || !currentSession || mode !== "Remote") return;
    const match = input.match(/(.*\s+)?([^\s]*)$/);
    const before = match?.[1] ?? "";
    const token = match?.[2] ?? "";
    if (!token && !before) return;
    const hasSlash = token.includes("/");
    const parentPath = hasSlash ? token.replace(/\/[^/]*$/, "") : currentDirPath;
    const prefix = hasSlash ? token.replace(/^.*\//, "") : token;
    const apiParent = (parentPath || "").trim() || "/";
    try {
      const entries = await api.listChildren(currentWatcher.id, currentSession.name, apiParent);
      const candidates = entries.filter(
        (e) => e.name && e.name.startsWith(prefix) && !e.name.startsWith(".")
      );
      if (candidates.length === 0) return;
      let namePart: string;
      if (candidates.length === 1) {
        const name = candidates[0]!.name;
        namePart = candidates[0]!.kind === "dir" ? `${name}/` : name;
      } else {
        const names = candidates.map((c) => c!.name);
        let common = names[0]!;
        for (let i = 1; i < names.length; i++) {
          while (names[i]!.indexOf(common) !== 0 && common.length > 0) {
            common = common.slice(0, -1);
          }
        }
        const exact = candidates.find((c) => c.name === common);
        namePart = exact?.kind === "dir" ? `${common}/` : common;
      }
      const completion = hasSlash && parentPath ? `${parentPath}/${namePart}` : namePart;
      setInput(before + completion);
    } catch {
      // ignore
    }
  }, [currentWatcher, currentSession, mode, input, currentDirPath]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!currentWatcher || !currentSession) return;

    if (mode === "Remote") {
      setLines((prev) =>
        [...prev, { id: `${Date.now()}-prompt`, text: `${promptText} ${trimmed}` }].slice(
          -MAX_TERMINAL_LINES
        )
      );
      try {
        const result = await api.sendRemoteCommand(currentWatcher.id, currentSession.name, trimmed);
        const ts = Date.now();
        // 実行経路を常に1行表示（追跡用）
        const trace = result?._trace;
        let statusLine: string;
        if (trace?.method === "rt") {
          const n = trace.outputLineCount ?? 0;
          const code = trace.exitCode ?? result?.exitCode ?? "?";
          statusLine = n > 0
            ? `[RT] 実行済み（出力 ${n} 行, 終了コード ${code}）`
            : `[RT] 実行済み（出力なし, 終了コード ${code}）`;
        } else if (trace?.method === "commands_txt") {
          statusLine = "[Relay] commands.txt に追記しました（Watcher のポールを待ちます）";
        } else {
          statusLine = trace
            ? "[Relay] 送信しました（応答に経路情報なし）"
            : "[Relay] 送信しました（Backend 要再起動で経路表示。出力なしの場合は Watcher のターミナルで [RT /command] ログを確認）";
        }
        if (preferences?.showCommandTrace) {
          setLines((prev) =>
            [...prev, { id: `${ts}-trace`, text: statusLine, isSystem: true }].slice(-MAX_TERMINAL_LINES)
          );
        }
        // 出力はバックグラウンドのログポールのみで表示する。
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        let display = `[Error] ${raw}`;
        if (raw.includes("503")) {
          try {
            const json = raw.replace(/^HTTP 503:\s*/, "");
            const data = JSON.parse(json) as { detail?: { hint?: string; rt_failed_reason?: string } };
            const hint = data.detail?.hint ?? data.detail?.rt_failed_reason ?? "";
            if (hint) display = `[Error] コマンド送信失敗。${hint} 画面上部の「接続診断」で rt_port を確認してください。`;
          } catch {
            /* use raw message */
          }
        }
        setLines((prev) =>
          [...prev, { id: `${Date.now()}-err`, text: display, isSystem: true }].slice(
            -MAX_TERMINAL_LINES
          )
        );
        return;
      }
    } else {
      // Local モードは当面ダミー
      setLines((prev) => [
        ...prev,
        { id: `${Date.now()}-local`, text: `[Local]$ ${trimmed}`, isSystem: true }
      ]);
    }
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setHistoryIndex(-1);
    setInput("");
  };

  const handleClearLog = async () => {
    if (mode === "Remote") {
      if (!currentWatcher || !currentSession) return;
      try {
        await api.sendRemoteCommand(currentWatcher.id, currentSession.name, "_internal_clear_log");
      } catch {
        // Ignore send failure here; user can retry from terminal input.
      }
      setLines([]);
      setInput("");
      setHistoryIndex(-1);
      return;
    }
    // Local mode: clear only the current view buffer.
    setLines([]);
    setInput("");
    setHistoryIndex(-1);
  };

  let displayedLines: TerminalLine[];
  try {
    displayedLines = lines.reduce<TerminalLine[]>((acc, line) => {
      if (!line || typeof line.text !== "string") return acc;
      const t = String(line.text).trim();
      if (!t) return acc;
      if (t.startsWith("__LS_DONE__::")) return acc;
      if (t.startsWith("__CMD_EXIT_CODE__::")) return acc;
      if (t.includes("_internal_")) return acc;
      if (t.startsWith("LS error:")) return acc;
      if (t.startsWith("Link: ln -sfn")) return acc;
      if (t.startsWith("Create file error:")) return acc;
      if (t.startsWith("Create dir error:")) return acc;
      if (t.startsWith("Delete error:")) return acc;
      if (t.startsWith("Move failed:")) return acc;
      if (t.startsWith("Stage failed:")) return acc;
      acc.push({
        id: String(line.id ?? `${acc.length}`),
        text: String(line.text),
        isSystem: Boolean(line.isSystem)
      });
      return acc;
    }, []);
  } catch {
    displayedLines = [];
  }

  return (
    <div className="pane pane-bottom">
      <div className="pane-header">
        <span className="pane-title">Terminal</span>
        <div className="pane-header-actions">
          <button className="primary-button" onClick={() => void handleClearLog()}>
            Clear Log
          </button>
          <label style={{ fontSize: "0.75rem", opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Auto scroll
          </label>
          <select
            className="session-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as "Remote" | "Local")}
            title={mode === "Local" ? "Web 版では Local はコマンド実行されず表示のみです。" : undefined}
          >
            <option value="Remote">Remote</option>
            <option value="Local">Local（表示のみ）</option>
          </select>
        </div>
      </div>
      <div className="terminal-body">
        <div
          ref={logRef}
          className="terminal-log"
          style={{ fontFamily: preferences.terminalFontFamily, fontSize: `${preferences.terminalFontSize}px` }}
          onScroll={(e) => {
            const target = e.currentTarget;
            const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 16;
            if (autoScroll && !nearBottom) setAutoScroll(false);
            if (!autoScroll && nearBottom) setAutoScroll(true);
          }}
        >
          {displayedLines.map((l, idx) => (
            <pre key={l?.id ?? `line-${idx}`} className={l?.isSystem ? "terminal-line system" : "terminal-line"}>
              {typeof l?.text === "string" ? l.text : String(l?.text ?? "")}
            </pre>
          ))}
          {displayedLines.length === 0 && (
            <div className="pane-empty terminal-empty">
              Remote モードで Watcher / Session を選択すると、ここにログが流れます。
            </div>
          )}
        </div>
        <div className="terminal-input-row">
          <span
            className="terminal-prompt"
            style={{ fontFamily: preferences.terminalFontFamily, fontSize: `${preferences.terminalFontSize}px` }}
            title={promptFullCwd ? "クリックでパスをコピー" : undefined}
            onClick={() => {
              if (promptFullCwd && navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(promptFullCwd);
              }
            }}
            role={promptFullCwd ? "button" : undefined}
          >
            {mode === "Remote" ? promptText : "[Local] $"}
          </span>
          <input
            ref={inputRef}
            className="terminal-input"
            style={{ fontFamily: preferences.terminalFontFamily, fontSize: `${preferences.terminalFontSize}px` }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
                e.preventDefault();
                setLines([]);
                return;
              }
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                void handleTabComplete();
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSend();
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                if (history.length === 0) return;
                const nextIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                setHistoryIndex(nextIndex);
                setInput(history[nextIndex] ?? "");
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (history.length === 0) return;
                if (historyIndex < 0) return;
                const nextIndex = historyIndex + 1;
                if (nextIndex >= history.length) {
                  setHistoryIndex(-1);
                  setInput("");
                } else {
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex] ?? "");
                }
              }
            }}
            placeholder=""
          />
        </div>
      </div>
    </div>
  );
};

