import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { api } from "../../lib/api";

const POLL_MS = 3000;

/** 1行の CSV（name が引用符付きの可能性あり）をパース */
function parseGpuCsvLine(line: string): { index: string; name: string; memUsed: number; memTotal: number; util: number; temp: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === '"') {
      const end = trimmed.indexOf('"', i + 1);
      if (end === -1) break;
      parts.push(trimmed.slice(i + 1, end).trim());
      i = end + 1;
    } else {
      const comma = trimmed.indexOf(",", i);
      const value = (comma === -1 ? trimmed.slice(i) : trimmed.slice(i, comma)).trim();
      parts.push(value);
      i = comma === -1 ? trimmed.length : comma + 1;
    }
  }
  if (parts.length < 6) return null;
  const memUsed = parseInt(parts[2], 10);
  const memTotal = parseInt(parts[3], 10);
  const util = parseInt(parts[4], 10);
  const temp = parseInt(parts[5], 10);
  if (Number.isNaN(memUsed) && Number.isNaN(memTotal)) return null;
  return {
    index: parts[0].trim(),
    name: (parts[1] || "GPU").trim(),
    memUsed: Number.isNaN(memUsed) ? 0 : memUsed,
    memTotal: Number.isNaN(memTotal) ? 0 : memTotal,
    util: Number.isNaN(util) ? 0 : util,
    temp: Number.isNaN(temp) ? 0 : temp
  };
}

function parseGpuOutput(output: string): ReturnType<typeof parseGpuCsvLine>[] {
  const rows: ReturnType<typeof parseGpuCsvLine>[] = [];
  for (const line of output.split("\n")) {
    const row = parseGpuCsvLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** 使用率で nvtop 風の色クラス */
function utilClass(util: number): string {
  if (util >= 90) return "gpu-util-high";
  if (util >= 60) return "gpu-util-mid";
  return "gpu-util-low";
}

function tempClass(temp: number): string {
  if (temp >= 85) return "gpu-temp-high";
  if (temp >= 70) return "gpu-temp-mid";
  return "gpu-temp-low";
}

function memClass(memUsed: number, memTotal: number): string {
  if (memTotal <= 0) return "gpu-mem-low";
  const pct = (memUsed / memTotal) * 100;
  if (pct >= 90) return "gpu-mem-high";
  if (pct >= 70) return "gpu-mem-mid";
  return "gpu-mem-low";
}

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

  const rows = parseGpuOutput(output);
  const showRaw = rows.length === 0 && output.length > 0;

  return (
    <div className="pane pane-right gpu-status-pane">
      <div className="pane-header">
        <span className="pane-title">GPU</span>
        <button type="button" className="icon-button" onClick={close} title="閉じる">
          ×
        </button>
      </div>
      <div className="gpu-status-body">
        {loading && !output && !error && <div className="gpu-status-loading">取得中…</div>}
        {error && <div className="gpu-status-error">{error}</div>}
        {rows.length > 0 && (
          <div className="gpu-cards">
            {rows.map((gpu) => (
              <div key={gpu.index} className="gpu-card">
                <div className="gpu-card-header">
                  <span className="gpu-card-index">GPU {gpu.index}</span>
                  <span className="gpu-card-name" title={gpu.name}>
                    {gpu.name.length > 18 ? gpu.name.slice(0, 16) + "…" : gpu.name}
                  </span>
                </div>
                <div className="gpu-card-row">
                  <span className="gpu-label">Mem</span>
                  <div className="gpu-bar-wrap">
                    <div
                      className={`gpu-bar ${memClass(gpu.memUsed, gpu.memTotal)}`}
                      style={{
                        width: gpu.memTotal > 0 ? `${Math.min(100, (gpu.memUsed / gpu.memTotal) * 100)}%` : "0%"
                      }}
                    />
                  </div>
                  <span className="gpu-value">{gpu.memUsed}/{gpu.memTotal}</span>
                </div>
                <div className="gpu-card-row">
                  <span className="gpu-label">Util</span>
                  <span className={`gpu-value ${utilClass(gpu.util)}`}>{gpu.util}%</span>
                </div>
                <div className="gpu-card-row">
                  <span className="gpu-label">Temp</span>
                  <span className={`gpu-value ${tempClass(gpu.temp)}`}>{gpu.temp}°C</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {showRaw && (
          <pre className="gpu-status-output gpu-status-raw">{output}</pre>
        )}
        {!output && !error && !loading && <div className="gpu-status-empty">nvidia-smi の出力がありません。</div>}
      </div>
    </div>
  );
};
