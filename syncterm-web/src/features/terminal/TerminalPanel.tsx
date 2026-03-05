import React, { useEffect, useRef, useState } from "react";
import { useSession } from "../session/SessionContext";
import type { TerminalLine } from "../../types/domain";
import { api } from "../../lib/api";
import { usePreferences } from "../preferences/PreferencesContext";

export const TerminalPanel: React.FC = () => {
  const { preferences } = usePreferences();
  const { currentWatcher, currentSession } = useSession();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"Remote" | "Local">("Remote");
  const [autoScroll, setAutoScroll] = useState(true);
  const [promptText, setPromptText] = useState("[Remote] $");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 初期ログ
  useEffect(() => {
    const load = async () => {
      if (!currentWatcher || !currentSession || mode !== "Remote") {
        setLines([]);
        setPromptText(mode === "Local" ? "[Local] $" : "[Remote] $");
        return;
      }
      const init = await api.getInitialLog(currentWatcher.id, currentSession.name);
      setLines(init);
      try {
        const st = await api.getWatcherStatus(currentWatcher.id, currentSession.name);
        const env = st.condaEnv && st.condaEnv !== "base" ? `(${st.condaEnv}) ` : "[Remote] ";
        setPromptText(`${env}${st.user}@${st.host}:${st.cwd}$`);
      } catch {
        setPromptText("[Remote] $");
      }
    };
    void load();
  }, [currentWatcher, currentSession, mode]);

  // 疑似ポーリング
  useEffect(() => {
    if (!currentWatcher || !currentSession || mode !== "Remote") return;

    let cancelled = false;
    const tick = async () => {
      if (!currentWatcher || !currentSession || cancelled) return;
      const all = await api.fetchLogTail(currentWatcher.id, currentSession.name);
      if (!cancelled && all.length > 0) {
        setLines((prev) => [...prev, ...all].slice(-preferences.terminalMaxLines));
      }
      if (!cancelled) setTimeout(tick, preferences.terminalPollMs);
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

  // Keep prompt updated like a real terminal prompt.
  useEffect(() => {
    if (!currentWatcher || !currentSession || mode !== "Remote") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const st = await api.getWatcherStatus(currentWatcher.id, currentSession.name);
        const env = st.condaEnv && st.condaEnv !== "base" ? `(${st.condaEnv}) ` : "[Remote] ";
        if (!cancelled) setPromptText(`${env}${st.user}@${st.host}:${st.cwd}$`);
      } catch {
        if (!cancelled) setPromptText("[Remote] $");
      }
      if (!cancelled) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [currentWatcher, currentSession, mode]);

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
      await api.sendRemoteCommand(currentWatcher.id, currentSession.name, trimmed);
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

  const visibleLines = lines.reduce<TerminalLine[]>((acc, line) => {
    const t = line.text.trim();
    if (!t) return acc;

    // Hide all control markers.
    if (t.startsWith("__LS_DONE__::")) return acc;
    if (t.startsWith("__CMD_EXIT_CODE__::")) {
      // Hide all exit markers from UI (both internal and user commands).
      return acc;
    }

    // Extra safety: do not render internal command strings.
    if (t.includes("_internal_")) return acc;
    if (t.startsWith("LS error:")) return acc;
    if (t.startsWith("Link: ln -sfn")) return acc;
    if (t.startsWith("Create file error:")) return acc;
    if (t.startsWith("Create dir error:")) return acc;
    if (t.startsWith("Delete error:")) return acc;
    if (t.startsWith("Move failed:")) return acc;
    if (t.startsWith("Stage failed:")) return acc;

    acc.push(line);
    return acc;
  }, []);
  const displayedLines = visibleLines;

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
          onClick={() => inputRef.current?.focus()}
          onScroll={(e) => {
            const target = e.currentTarget;
            const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 16;
            if (autoScroll && !nearBottom) setAutoScroll(false);
            if (!autoScroll && nearBottom) setAutoScroll(true);
          }}
        >
          {displayedLines.map((l) => (
            <pre key={l.id} className={l.isSystem ? "terminal-line system" : "terminal-line"}>
              {l.text}
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
                e.preventDefault();
                setInput("");
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

