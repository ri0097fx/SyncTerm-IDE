import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { api } from "../../lib/api";

const POLL_MS = 3000;
const PROC_DELIM = "___PROC___";

export type GpuRow = {
  index: string;
  name: string;
  memUsed: number;
  memTotal: number;
  util: number;
  temp: number;
};

export type GpuProcessRow = { pid: string; name: string; usedMemory: number };

/** 1行の CSV（name が引用符付きの可能性あり）をパース */
function parseGpuCsvLine(line: string): GpuRow | null {
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

function parseProcessCsvLine(line: string): GpuProcessRow | null {
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
  if (parts.length < 3) return null;
  const usedMemory = parseInt(parts[2], 10);
  return {
    pid: parts[0].trim(),
    name: (parts[1] || "").trim(),
    usedMemory: Number.isNaN(usedMemory) ? 0 : usedMemory
  };
}

function parseNvidiaSmiOutput(output: string): { gpus: GpuRow[]; processes: GpuProcessRow[] } {
  const [gpuPart, procPart] = output.split(PROC_DELIM).map((s) => s.trim());
  const gpus: GpuRow[] = [];
  for (const line of (gpuPart || "").split("\n")) {
    const row = parseGpuCsvLine(line);
    if (row) gpus.push(row);
  }
  const processes: GpuProcessRow[] = [];
  for (const line of (procPart || "").split("\n")) {
    const row = parseProcessCsvLine(line);
    if (row) processes.push(row);
  }
  return { gpus, processes };
}

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

/** nvitop JSON の簡易型（実際の --snapshot 出力に合わせて調整可能） */
type NvitopData = {
  devices?: Array<{
    index?: number;
    name?: string;
    memory_used?: number;
    memory_total?: number;
    utilization?: number;
    temperature?: number;
    processes?: Array<{ pid?: number; command?: string; gpu_memory?: number }>;
  }>;
  host?: { cpu_percent?: number; memory_percent?: number };
};

function renderNvitop(data: NvitopData): { gpus: GpuRow[]; processes: GpuProcessRow[]; host?: { cpu: number; mem: number } } {
  const gpus: GpuRow[] = [];
  const processes: GpuProcessRow[] = [];
  const devices = data.devices ?? [];
  for (const d of devices) {
    const idx = d.index ?? gpus.length;
    gpus.push({
      index: String(idx),
      name: d.name ?? "GPU",
      memUsed: d.memory_used ?? 0,
      memTotal: d.memory_total ?? 0,
      util: d.utilization ?? 0,
      temp: d.temperature ?? 0
    });
    for (const p of d.processes ?? []) {
      processes.push({
        pid: String(p.pid ?? ""),
        name: (p.command ?? "").slice(0, 40),
        usedMemory: p.gpu_memory ?? 0
      });
    }
  }
  const host = data.host
    ? { cpu: data.host.cpu_percent ?? 0, mem: data.host.memory_percent ?? 0 }
    : undefined;
  return { gpus, processes, host };
}

export const GpuStatusPanel: React.FC = () => {
  const { currentWatcher, currentSession } = useSession();
  const { updatePreferences } = usePreferences();
  const [output, setOutput] = useState("");
  const [source, setSource] = useState<"nvitop" | "nvidia-smi">("nvidia-smi");
  const [nvitopData, setNvitopData] = useState<unknown>(null);
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
      setSource(res.source ?? "nvidia-smi");
      if (res.data != null) setNvitopData(res.data);
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

  let gpus: GpuRow[] = [];
  let processes: GpuProcessRow[] = [];
  let host: { cpu: number; mem: number } | undefined;

  if (source === "nvitop" && nvitopData && typeof nvitopData === "object") {
    const parsed = renderNvitop(nvitopData as NvitopData);
    gpus = parsed.gpus;
    processes = parsed.processes;
    host = parsed.host;
  } else {
    const parsed = parseNvidiaSmiOutput(output);
    gpus = parsed.gpus;
    processes = parsed.processes;
  }

  const showRaw = gpus.length === 0 && output.length > 0 && !nvitopData;

  return (
    <div className="pane pane-right gpu-status-pane">
      <div className="pane-header">
        <span className="pane-title">GPU{source === "nvitop" ? " (nvitop)" : ""}</span>
        <button type="button" className="icon-button" onClick={close} title="閉じる">
          ×
        </button>
      </div>
      <div className="gpu-status-body gpu-status-body-responsive">
        {loading && !output && !error && <div className="gpu-status-loading">取得中…</div>}
        {error && <div className="gpu-status-error">{error}</div>}
        {host !== undefined && (
          <div className="gpu-host-row">
            <span className="gpu-label">CPU</span>
            <span className={`gpu-value ${utilClass(host.cpu)}`}>{host.cpu.toFixed(0)}%</span>
            <span className="gpu-label">Mem</span>
            <span className={`gpu-value ${memClass(host.mem, 100)}`}>{host.mem.toFixed(0)}%</span>
          </div>
        )}
        {gpus.length > 0 && (
          <div className="gpu-cards">
            {gpus.map((gpu) => (
              <div key={gpu.index} className="gpu-card">
                <div className="gpu-card-header">
                  <span className="gpu-card-index">GPU {gpu.index}</span>
                  <span className="gpu-card-name" title={gpu.name}>
                    {gpu.name.length > 20 ? gpu.name.slice(0, 18) + "…" : gpu.name}
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
        {processes.length > 0 && (
          <div className="gpu-processes">
            <div className="gpu-processes-title">プロセス</div>
            <div className="gpu-processes-list">
              {processes.map((p, i) => (
                <div key={`${p.pid}-${i}`} className="gpu-process-row">
                  <span className="gpu-process-pid">{p.pid}</span>
                  <span className="gpu-process-mem">{p.usedMemory} MiB</span>
                  <span className="gpu-process-name" title={p.name}>{p.name || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {showRaw && (
          <pre className="gpu-status-output gpu-status-raw">{output}</pre>
        )}
        {!output && !error && !loading && gpus.length === 0 && (
          <div className="gpu-status-empty">nvidia-smi / nvitop の出力がありません。</div>
        )}
      </div>
    </div>
  );
};
