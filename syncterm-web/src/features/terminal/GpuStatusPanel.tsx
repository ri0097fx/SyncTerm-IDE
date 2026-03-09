import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { api } from "../../lib/api";

const POLL_MS = 3000;

export const GpuStatusPanel: React.FC = () => {
  const { currentWatcher, currentSession } = useSession();
  const { updatePreferences } = usePreferences();
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchGpu = useCallback(async () => {
    if (!currentWatcher || !currentSession) {
      setOutput("");
      setError("Watcher / Session を選択してください");
      return;
    }
    try {
      setError(null);
      const res = await api.getGpuStatus(currentWatcher.id, currentSession.name);
      setOutput(res.output ?? "");
      if (res.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
      setOutput("");
    } finally {
      setLoading(false);
    }
  }, [currentWatcher?.id, currentSession?.name]);

  useEffect(() => {
    fetchGpu();
    const id = setInterval(fetchGpu, POLL_MS);
    return () => clearInterval(id);
  }, [fetchGpu]);

  const close = () => updatePreferences({ showGpuPanel: false });

  return (
    <div className="pane pane-right gpu-status-pane">
      <div className="pane-header">
        <span className="pane-title">GPU 状態 (nvidia-smi)</span>
        <button type="button" className="icon-button" onClick={close} title="閉じる">
          ×
        </button>
      </div>
      <div className="gpu-status-body">
        {loading && !output && !error && <div className="gpu-status-loading">取得中…</div>}
        {error && <div className="gpu-status-error">{error}</div>}
        <pre className="gpu-status-output">{output || (error ? "" : "nvidia-smi の出力がありません。")}</pre>
      </div>
    </div>
  );
};
