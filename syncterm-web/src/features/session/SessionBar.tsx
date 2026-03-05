import React from "react";
import { useSession } from "./SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { api } from "../../lib/api";

export const SessionBar: React.FC = () => {
  const [showPrefs, setShowPrefs] = React.useState(false);
  const [cleanupMessage, setCleanupMessage] = React.useState<string | null>(null);
  const { watchers, sessions, currentWatcher, currentSession, setWatcher, setSession, refreshWatchers, runnerConfig } =
    useSession();
  const { preferences, updatePreferences, resetPreferences } = usePreferences();

  const handleCleanupStaged = async () => {
    if (!currentWatcher || !currentSession) return;
    try {
      const res = await api.cleanupStagedCache(currentWatcher.id, currentSession.name);
      const failNote = (res.failed ?? 0) > 0 ? `（削除できず: ${res.failed} 件）` : "";
      const relayNote =
        res.relay_session_exists === false
          ? "（relay にセッションがありませんでした）"
          : "";
      const msg = res.watcher_cleaned
        ? `Staged キャッシュを削除しました（relay: ${res.deleted} 件, Watcher 側も削除済み）${failNote}${relayNote}`
        : `Staged キャッシュを削除しました（relay: ${res.deleted} 件）${failNote}${relayNote}`;
      setCleanupMessage(msg);
      setTimeout(() => setCleanupMessage(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "削除に失敗しました";
      setCleanupMessage(message);
      setTimeout(() => setCleanupMessage(null), 5000);
    }
  };

  return (
    <>
      <header className="session-bar">
        <div className="session-bar-left">
          <span className="session-bar-label">Watcher</span>
          <select
            className="session-select"
            value={currentWatcher?.id ?? ""}
            onChange={(e) => setWatcher(e.target.value)}
          >
            {watchers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.displayName}
              </option>
            ))}
          </select>
          <button className="icon-button" onClick={refreshWatchers} title="Reload watchers">
            ↻
          </button>

          <span className="session-bar-label">Session</span>
          <select
            className="session-select"
            value={currentSession?.name ?? ""}
            onChange={(e) => setSession(e.target.value)}
          >
            {sessions.map((s) => (
              <option key={`${s.watcherId}/${s.name}`} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          {currentWatcher && currentSession && (
            <button
              className="icon-button"
              style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.5rem" }}
              onClick={handleCleanupStaged}
              title="Staged キャッシュを一括削除"
            >
              キャッシュ削除
            </button>
          )}
          {cleanupMessage && (
            <span className="session-bar-message" style={{ marginLeft: "0.5rem", fontSize: "0.85rem", opacity: 0.9 }}>
              {cleanupMessage}
            </span>
          )}
        </div>

        <div className="session-bar-right">
          {runnerConfig && (
            <span className="runner-pill">
              Runner: <strong>{runnerConfig.mode}</strong>
            </span>
          )}
          <button
            className="icon-button"
            style={{ width: "auto", padding: "0 0.7rem" }}
            onClick={() => setShowPrefs(true)}
            title="Preferences"
          >
            Preferences
          </button>
        </div>
      </header>

      {showPrefs && (
        <div className="modal-overlay" onClick={() => setShowPrefs(false)}>
          <div className="modal-card preferences-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Preferences</h3>
            <div className="preferences-grid">
              <label className="modal-label">
                Theme
                <select
                  className="modal-input"
                  value={preferences.theme}
                  onChange={(e) =>
                    updatePreferences({ theme: e.target.value as "dark" | "light" | "spyder" })
                  }
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="spyder">Spyder</option>
                </select>
              </label>
              <label className="modal-label">
                UI Density
                <select
                  className="modal-input"
                  value={preferences.uiDensity}
                  onChange={(e) =>
                    updatePreferences({ uiDensity: e.target.value as "comfortable" | "compact" })
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label className="modal-label">
                Editor Theme
                <select
                  className="modal-input"
                  value={preferences.editorTheme}
                  onChange={(e) =>
                    updatePreferences({
                      editorTheme: e.target.value as "vs-dark" | "vs-light" | "spyder"
                    })
                  }
                >
                  <option value="vs-dark">Dark</option>
                  <option value="vs-light">Light</option>
                  <option value="spyder">Spyder</option>
                </select>
              </label>
              <label className="modal-label">
                Editor Keymap
                <select
                  className="modal-input"
                  value={preferences.editorKeymap}
                  onChange={(e) =>
                    updatePreferences({ editorKeymap: e.target.value as "vscode" | "spyder" })
                  }
                >
                  <option value="vscode">VSCode-like</option>
                  <option value="spyder">Spyder-like</option>
                </select>
              </label>
              <label className="modal-label">
                Editor Font Size
                <input
                  className="modal-input"
                  type="number"
                  min={10}
                  max={24}
                  value={preferences.editorFontSize}
                  onChange={(e) => updatePreferences({ editorFontSize: Number(e.target.value) })}
                />
              </label>
              <label className="modal-label">
                Editor Font Family
                <input
                  className="modal-input"
                  value={preferences.editorFontFamily}
                  onChange={(e) => updatePreferences({ editorFontFamily: e.target.value })}
                />
              </label>
              <label className="modal-label">
                Editor Word Wrap
                <select
                  className="modal-input"
                  value={preferences.editorWordWrap}
                  onChange={(e) =>
                    updatePreferences({ editorWordWrap: e.target.value as "off" | "on" })
                  }
                >
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
              </label>
              <label className="modal-label modal-checkbox">
                <input
                  type="checkbox"
                  checked={preferences.editorLineNumbers}
                  onChange={(e) => updatePreferences({ editorLineNumbers: e.target.checked })}
                />
                Show editor line numbers
              </label>
              <label className="modal-label modal-checkbox">
                <input
                  type="checkbox"
                  checked={preferences.editorMinimap}
                  onChange={(e) => updatePreferences({ editorMinimap: e.target.checked })}
                />
                Show editor minimap
              </label>
              <label className="modal-label">
                Terminal Font Size
                <input
                  className="modal-input"
                  type="number"
                  min={10}
                  max={24}
                  value={preferences.terminalFontSize}
                  onChange={(e) => updatePreferences({ terminalFontSize: Number(e.target.value) })}
                />
              </label>
              <label className="modal-label">
                Terminal Font Family
                <input
                  className="modal-input"
                  value={preferences.terminalFontFamily}
                  onChange={(e) => updatePreferences({ terminalFontFamily: e.target.value })}
                />
              </label>
              <label className="modal-label">
                Terminal Max Lines
                <input
                  className="modal-input"
                  type="number"
                  min={500}
                  max={30000}
                  step={100}
                  value={preferences.terminalMaxLines}
                  onChange={(e) => updatePreferences({ terminalMaxLines: Number(e.target.value) })}
                />
              </label>
              <label className="modal-label">
                Terminal Poll Interval (ms)
                <input
                  className="modal-input"
                  type="number"
                  min={200}
                  max={5000}
                  step={100}
                  value={preferences.terminalPollMs}
                  onChange={(e) => updatePreferences({ terminalPollMs: Number(e.target.value) })}
                />
              </label>
              <label className="modal-label modal-checkbox">
                <input
                  type="checkbox"
                  checked={preferences.showImagePreviewPane}
                  onChange={(e) => updatePreferences({ showImagePreviewPane: e.target.checked })}
                />
                Show image preview side pane
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="icon-button"
                style={{ width: "auto", padding: "0 0.8rem", borderRadius: "999px" }}
                onClick={resetPreferences}
              >
                Reset
              </button>
              <button className="primary-button" onClick={() => setShowPrefs(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

