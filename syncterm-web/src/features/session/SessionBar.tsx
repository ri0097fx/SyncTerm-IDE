import React from "react";
import { useSession } from "./SessionContext";
import { ExtensionCommandPaletteModal } from "../extensions/ExtensionCommandPaletteModal";
import { usePreferences } from "../preferences/PreferencesContext";
import { MarketplaceModal } from "../extensions/MarketplaceModal";
import { useExtensionRuntime } from "../extensions/ExtensionRuntimeContext";
import { QuickToggle } from "../extensions/QuickToggle";
import { api } from "../../lib/api";

type RtStatus = {
  registry_root: string;
  rt_port_file_exists: boolean;
  rt_port: number | null;
};

export const SessionBar: React.FC = () => {
  const [showPrefs, setShowPrefs] = React.useState(false);
  const [showMarketplace, setShowMarketplace] = React.useState(false);
  const [showCommandPalette, setShowCommandPalette] = React.useState(false);
  const [cleanupMessage, setCleanupMessage] = React.useState<string | null>(null);
  const [showRtDiagnostic, setShowRtDiagnostic] = React.useState(false);
  const [rtStatus, setRtStatus] = React.useState<RtStatus | null>(null);
  const [rtDiagnosticError, setRtDiagnosticError] = React.useState<string | null>(null);
  const [debugRtResult, setDebugRtResult] = React.useState<{ ok: boolean; error?: string; response?: unknown } | null>(null);
  const [aiTestResult, setAiTestResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [aiInlineTestResult, setAiInlineTestResult] = React.useState<{ ok: boolean; raw: string } | null>(null);
  const [aiTestLoading, setAiTestLoading] = React.useState(false);
  const [aiInlineTestLoading, setAiInlineTestLoading] = React.useState(false);
  const [newSessionName, setNewSessionName] = React.useState("");
  const [createSessionError, setCreateSessionError] = React.useState<string | null>(null);
  const { watchers, sessions, currentWatcher, currentSession, setWatcher, setSession, refreshWatchers, refreshSessions, runnerConfig } =
    useSession();
  const { commands } = useExtensionRuntime();
  const { preferences, updatePreferences, resetPreferences } = usePreferences();

  const handleRtDiagnostic = async () => {
    if (!currentWatcher) return;
    setRtDiagnosticError(null);
    setRtStatus(null);
    setDebugRtResult(null);
    setShowRtDiagnostic(true);
    try {
      const res = await api.getRtStatus(currentWatcher.id);
      setRtStatus(res);
    } catch (err) {
      setRtDiagnosticError(err instanceof Error ? err.message : "取得に失敗しました");
    }
  };

  const handleDebugRt = async () => {
    if (!currentWatcher || !currentSession) return;
    setDebugRtResult(null);
    try {
      const res = await api.getDebugRt(currentWatcher.id, currentSession.name);
      setDebugRtResult({ ok: res.ok, error: res.error, response: res.response });
    } catch (err) {
      setDebugRtResult({ ok: false, error: err instanceof Error ? err.message : "接続テストに失敗しました" });
    }
  };

  const handleAiAssistTest = async () => {
    if (!currentWatcher || !currentSession) return;
    setAiTestResult(null);
    setAiTestLoading(true);
    try {
      const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
        path: "",
        action: "chat",
        prompt: "Say exactly: OK",
        fileContent: "",
        history: []
      });
      setAiTestResult({ ok: true, message: (res.result ?? "").trim() || "(empty reply)" });
    } catch (err) {
      setAiTestResult({ ok: false, message: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setAiTestLoading(false);
    }
  };

  const handleAiInlineTest = async () => {
    if (!currentWatcher || !currentSession) return;
    setAiInlineTestResult(null);
    setAiInlineTestLoading(true);
    try {
      const res = await api.getAiInlineCompletion(currentWatcher.id, currentSession.name, {
        path: "test.py",
        prefix: "def hello",
        suffix: "",
        language: "python"
      });
      const raw = (res.completion ?? "").trim();
      setAiInlineTestResult({ ok: true, raw: raw || "(空)" });
    } catch (err) {
      setAiInlineTestResult({ ok: false, raw: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setAiInlineTestLoading(false);
    }
  };

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
        ? `キャッシュ・commands を削除しました（relay: ${res.deleted} 件, Watcher 側も削除済み）${failNote}${relayNote}`
        : `キャッシュ・commands を削除しました（relay: ${res.deleted} 件）${failNote}${relayNote}`;
      setCleanupMessage(msg);
      setTimeout(() => setCleanupMessage(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "削除に失敗しました";
      setCleanupMessage(message);
      setTimeout(() => setCleanupMessage(null), 5000);
    }
  };

  const handleCreateSession = async () => {
    const name = newSessionName.trim();
    if (!name || !currentWatcher) return;
    setCreateSessionError(null);
    try {
      await api.createSession(currentWatcher.id, name);
      setNewSessionName("");
      await refreshSessions(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : "作成に失敗しました";
      setCreateSessionError(message);
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
          {currentWatcher && (
            <span style={{ display: "inline-flex", alignItems: "center", marginLeft: "0.25rem", gap: "0.25rem" }}>
              <input
                type="text"
                className="session-select"
                placeholder="新規セッション名"
                value={newSessionName}
                onChange={(e) => { setNewSessionName(e.target.value); setCreateSessionError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreateSession(); } }}
                style={{ width: "8rem", padding: "0.2rem 0.4rem" }}
              />
              <button
                type="button"
                className="icon-button"
                style={{ width: "auto", padding: "0 0.5rem" }}
                onClick={(e) => { e.preventDefault(); handleCreateSession(); }}
                title="セッションを新規作成"
              >
                作成
              </button>
            </span>
          )}
          {createSessionError && (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "var(--color-error, #f87171)" }}>
              {createSessionError}
            </span>
          )}
          {currentWatcher && (
            <button
              className="icon-button"
              style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.5rem" }}
              onClick={handleRtDiagnostic}
              title="診断（RT・AI 動作確認・キャッシュ削除）"
            >
              診断
            </button>
          )}
          {currentWatcher && currentSession && (
            <button
              className={`icon-button${preferences.showGpuPanel ? " active" : ""}`}
              style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.25rem" }}
              onClick={() => updatePreferences({ showGpuPanel: !preferences.showGpuPanel })}
              title="GPU 状態 (nvidia-smi) を逐次表示"
            >
              GPU
            </button>
          )}
          {currentWatcher && currentSession && (
            <button
              className={`icon-button${preferences.showAiChatPanel ? " active" : ""}`}
              style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.25rem" }}
              onClick={() => updatePreferences({ showAiChatPanel: !preferences.showAiChatPanel })}
              title="AI チャット・動作確認"
            >
              AI
            </button>
          )}
          <button
            className="icon-button"
            style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.25rem" }}
            onClick={() => setShowMarketplace(true)}
            title="拡張機能マーケットプレイス"
          >
            Extensions
          </button>
          <QuickToggle disabled={!currentWatcher || !currentSession} />
          <button
            className="icon-button"
            style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.25rem" }}
            onClick={() => setShowCommandPalette(true)}
            title="有効化済み拡張のコマンドを実行"
            disabled={commands.length === 0}
          >
            Commands
          </button>
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

      <MarketplaceModal open={showMarketplace} onClose={() => setShowMarketplace(false)} />
      <ExtensionCommandPaletteModal open={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
      {showRtDiagnostic && (
        <div className="modal-overlay" onClick={() => { setShowRtDiagnostic(false); setRtStatus(null); setRtDiagnosticError(null); setDebugRtResult(null); setAiTestResult(null); setAiInlineTestResult(null); }}>
          <div className="modal-card preferences-modal" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">診断（RT・AI・キャッシュ）</h3>

            <section style={{ marginBottom: "1rem" }}>
              <h4 style={{ fontSize: "0.95rem", marginBottom: "0.5rem" }}>RT 接続</h4>
              {rtDiagnosticError && (
                <p style={{ color: "var(--error)", marginBottom: "0.5rem" }}>{rtDiagnosticError}</p>
              )}
              {rtStatus && (
                <div style={{ fontFamily: "monospace", fontSize: "0.9rem", marginBottom: "0.5rem" }}>
                  <p><strong>registry_root:</strong> {rtStatus.registry_root}</p>
                  <p><strong>rt_port ファイル:</strong> {rtStatus.rt_port_file_exists ? "あり" : "なし"}</p>
                  <p><strong>rt_port:</strong> {rtStatus.rt_port ?? "—"}</p>
                  {!rtStatus.rt_port_file_exists && (
                    <p style={{ marginTop: "0.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                      Relay に <code>_registry/{currentWatcher?.id}.rt_port</code> がありません。Watcher と Relay の config.ini の base_path を一致させ、Watcher 側で rsync を実行してください。
                    </p>
                  )}
                  {rtStatus.rt_port_file_exists && rtStatus.rt_port != null && (
                    <p style={{ marginTop: "0.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                      rt_port はあります。コマンドが届かない場合は「RT 接続テスト」で Relay→Watcher の HTTP を確認してください。
                    </p>
                  )}
                </div>
              )}
              {currentWatcher && (
                <button type="button" className="icon-button" style={{ width: "auto", padding: "0 0.6rem", marginRight: "0.35rem" }} onClick={handleRtDiagnostic} title="RT 状態を取得">
                  {rtStatus ? "再取得" : "取得"}
                </button>
              )}
              {currentWatcher && currentSession && rtStatus?.rt_port != null && (
                <>
                  <button type="button" className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={handleDebugRt} title="Relay から Watcher へ HTTP で echo コマンドを送り、応答を確認">
                    RT 接続テスト
                  </button>
                  {debugRtResult && (
                    <div style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
                      {debugRtResult.ok ? (
                        <p style={{ color: "var(--success, green)" }}>接続成功（Watcher が応答しました）</p>
                      ) : (
                        <p style={{ color: "var(--error)" }}>失敗: {debugRtResult.error}</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>

            <section style={{ marginBottom: "1rem" }}>
              <h4 style={{ fontSize: "0.95rem", marginBottom: "0.5rem" }}>AI 動作確認</h4>
              {currentWatcher && currentSession ? (
                <>
                  <button type="button" className="primary-button" disabled={aiTestLoading} onClick={handleAiAssistTest} style={{ marginRight: "0.35rem" }}>
                    {aiTestLoading ? "送信中…" : "AI アシスト接続テスト"}
                  </button>
                  <button type="button" className="primary-button" disabled={aiInlineTestLoading} onClick={handleAiInlineTest}>
                    {aiInlineTestLoading ? "取得中…" : "インライン補完 API テスト"}
                  </button>
                  {aiTestResult && (
                    <div className={`ai-chat-test-result ${aiTestResult.ok ? "ok" : "ng"}`} style={{ marginTop: "0.5rem" }}>
                      {aiTestResult.ok ? "OK" : "エラー"}: {aiTestResult.message}
                    </div>
                  )}
                  {aiInlineTestResult && (
                    <div className={`ai-chat-test-result ${aiInlineTestResult.ok ? "ok" : "ng"}`} style={{ marginTop: "0.25rem" }}>
                      {aiInlineTestResult.ok ? "API応答" : "エラー"}: {aiInlineTestResult.raw.slice(0, 200)}{aiInlineTestResult.raw.length > 200 ? "…" : ""}
                    </div>
                  )}
                  <p style={{ marginTop: "0.5rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                    インライン補完: ファイルを開き 2 文字以上入力後、Tab で確定。動かない場合は上で API テストを実行してください。
                  </p>
                </>
              ) : (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Watcher と Session を選択してください。</p>
              )}
            </section>

            <section style={{ marginBottom: "1rem" }}>
              <h4 style={{ fontSize: "0.95rem", marginBottom: "0.5rem" }}>キャッシュ・commands 削除</h4>
              {currentWatcher && currentSession ? (
                <button type="button" className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={handleCleanupStaged} title="Staged キャッシュと commands を一括削除">
                  キャッシュ・commands 削除
                </button>
              ) : (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Watcher と Session を選択してください。</p>
              )}
            </section>

            <div className="modal-actions">
              <button className="primary-button" onClick={() => { setShowRtDiagnostic(false); setRtStatus(null); setRtDiagnosticError(null); setDebugRtResult(null); setAiTestResult(null); setAiInlineTestResult(null); }}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

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
              <label className="modal-label modal-checkbox">
                <input
                  type="checkbox"
                  checked={preferences.showCommandTrace}
                  onChange={(e) => updatePreferences({ showCommandTrace: e.target.checked })}
                />
                Show command execution trace & file tree op log (debug)
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

