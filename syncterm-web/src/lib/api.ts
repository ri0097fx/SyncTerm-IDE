import type {
  FileEntry,
  RunnerConfig,
  SessionInfo,
  TerminalLine,
  WatcherInfo,
  WatcherStatus
} from "../types/domain";

export interface BuddyState {
  stats: {
    total_feedback: number;
    per_task: {
      [task: string]: {
        total: number;
        good: number;
        bad: number;
        best_mode?: string;
        best_thinking?: string;
      };
    };
  };
  routing: {
    [task: string]: {
      [mode: string]: {
        [thinking: string]: { good: number; bad: number };
      };
    };
  };
  hints: { id: string; text: string }[];
}

export interface SyncApi {
  listWatchers(): Promise<WatcherInfo[]>;
  listSessions(watcherId: string): Promise<SessionInfo[]>;
  createSession(watcherId: string, name: string): Promise<SessionInfo>;
  getWatcherStatus(watcherId: string, session: string): Promise<WatcherStatus>;
  getInitialLog(watcherId: string, session: string): Promise<TerminalLine[]>;
  sendRemoteCommand(
    watcherId: string,
    session: string,
    command: string
  ): Promise<{
    output?: string;
    exitCode?: number;
    _trace?: { method: "rt" | "commands_txt"; outputLineCount?: number; exitCode?: number };
  }>;
  fetchLogTail(watcherId: string, session: string): Promise<TerminalLine[]>;

  listFiles(watcherId: string, session: string): Promise<FileEntry[]>;
  listChildren(
    watcherId: string,
    session: string,
    path: string
  ): Promise<FileEntry[]>;
  createSymlink(
    watcherId: string,
    session: string,
    sourcePath: string,
    linkName: string
  ): Promise<void>;

  createPath(
    watcherId: string,
    session: string,
    path: string,
    kind: "file" | "dir"
  ): Promise<{ ok: boolean; rt?: boolean }>;
  deletePath(watcherId: string, session: string, path: string): Promise<{ ok: boolean; rt?: boolean }>;
  copyPath(
    watcherId: string,
    session: string,
    sourcePath: string,
    destPath: string
  ): Promise<{ ok: boolean; rt?: boolean }>;
  movePath(
    watcherId: string,
    session: string,
    sourcePath: string,
    destPath: string
  ): Promise<{ ok: boolean; rt?: boolean }>;

  uploadFile(
    watcherId: string,
    session: string,
    path: string,
    contentBase64: string
  ): Promise<{ ok: boolean; rt?: boolean }>;

  fetchFileContent(
    watcherId: string,
    session: string,
    path: string
  ): Promise<string>;
  fetchFileChunk(
    watcherId: string,
    session: string,
    path: string,
    offset: number,
    length?: number
  ): Promise<{ content: string; nextOffset: number; hasMore: boolean; totalSize: number }>;
  saveFileContent(
    watcherId: string,
    session: string,
    path: string,
    content: string
  ): Promise<void>;
  getRawFileUrl(watcherId: string, session: string, path: string): string;
  getRawFileBlob(
    watcherId: string,
    session: string,
    path: string,
    signal?: AbortSignal
  ): Promise<Blob>;
  getAiModels(watcherId: string, session: string): Promise<{ installed: string[]; suggested: string[]; recommended?: string[]; provider?: string }>;
  ensureAiModel(watcherId: string, session: string, model: string): Promise<{ ok: boolean }>;
  /** モデル pull の進捗をストリーム。onProgress に { status, percent?, error? } が渡る。*/
  ensureAiModelStream(
    watcherId: string,
    session: string,
    model: string,
    onProgress: (ev: { status?: string; percent?: number; error?: string }) => void
  ): Promise<{ ok: boolean }>;
  runAiAssist(
    watcherId: string,
    session: string,
    payload: {
      path: string;
      action: string;
      prompt: string;
      selectedText?: string;
      fileContent: string;
      history?: { role: string; content: string }[];
      model?: string;
      mode?: string;
      editorPath?: string;
      editorSelectedText?: string;
      editorContent?: string;
      thinking?: string;
      persona?: string;
      hybridRouting?: boolean;
    },
    options?: { signal?: AbortSignal }
  ): Promise<{
    result: string;
    command?: string;
    needsApproval?: boolean;
    logs?: { command: string; exitCode?: number; output?: string; error?: string }[];
    debates?: {
      id: string;
      title?: string;
      models: string[];
      turns: { round: number; speaker: string; model: string; role: string; content: string }[];
    }[];
  }>;

  /** text/event-stream で AI 応答をストリーミング受信する */
  streamAi(
    watcherId: string,
    session: string,
    payload: {
      path: string;
      action: string;
      prompt: string;
      selectedText?: string;
      fileContent: string;
      history?: { role: string; content: string }[];
      model?: string;
      mode?: string;
      editorPath?: string;
      editorSelectedText?: string;
      editorContent?: string;
      thinking?: string;
      persona?: string;
      hybridRouting?: boolean;
    },
    onEvent: (ev: {
      type: "token" | "done" | "debate_turn";
      delta?: string;
      result?: string;
      command?: string;
      needsApproval?: boolean;
      truncated?: boolean;
      autoContinued?: boolean;
      logs?: { command: string; exitCode?: number; output?: string; error?: string }[];
      debates?: {
        id: string;
        title?: string;
        models: string[];
        turns: { round: number; speaker: string; model: string; role: string; content: string }[];
      }[];
      debateId?: string;
      turn?: { round: number; speaker: string; model: string; role: string; content: string };
    }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
  sendAiBuddyFeedback(
    payload: {
      message: string;
      role: string;
      rating: "good" | "bad";
      taskType?: string;
      mode?: string;
      thinking?: string;
      model?: string;
      watcherId?: string;
      session?: string;
    }
  ): Promise<{ ok: boolean }>;
  getAiBuddyState(): Promise<BuddyState>;
  getAiInlineCompletion(
    watcherId: string,
    session: string,
    payload: { path: string; prefix: string; suffix: string; language?: string; model?: string }
  ): Promise<{ completion: string }>;

  getRunnerConfig(watcherId: string, session: string): Promise<RunnerConfig | null>;
  updateRunnerConfig(
    watcherId: string,
    session: string,
    config: RunnerConfig
  ): Promise<void>;

  /** RT モード診断（rt_port の有無など） */
  getRtStatus(watcherId: string): Promise<{
    registry_root: string;
    rt_port_file_exists: boolean;
    rt_port: number | null;
  }>;

  /** RT 接続テスト（Relay → Watcher の HTTP が通るか） */
  getDebugRt(watcherId: string, session: string): Promise<{
    ok: boolean;
    error?: string;
    port?: number | null;
    response?: unknown;
  }>;

  /** 現在セッションの staged キャッシュと commands を一括削除 */
  cleanupStagedCache(watcherId: string, session: string): Promise<{
    deleted: number;
    failed?: number;
    watcher_cleaned: boolean;
    relay_session_exists?: boolean;
  }>;

  /** Watcher 上で nvitop / nvidia-smi を実行した結果（逐次表示用にポーリング） */
  getGpuStatus(watcherId: string, session: string): Promise<{
    output: string;
    error?: string;
    ok: boolean;
    exitCode?: number;
    source: "nvitop" | "nvidia-smi";
    data?: unknown;
  }>;
}

// --------------------------------------------------------------------------------
// HTTP 実装（FastAPI バックエンドと通信）
// --------------------------------------------------------------------------------

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function httpBase<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

class HttpSyncApi implements SyncApi {
  private logOffsets: Record<string, number> = {};

  private key(w: string, s: string) {
    return `${w}::${s}`;
  }

  async listWatchers(): Promise<WatcherInfo[]> {
    return http<WatcherInfo[]>("/watchers");
  }

  async listSessions(watcherId: string): Promise<SessionInfo[]> {
    return http<SessionInfo[]>(`/watchers/${encodeURIComponent(watcherId)}/sessions`);
  }

  async createSession(watcherId: string, name: string): Promise<SessionInfo> {
    return http<SessionInfo>(`/watchers/${encodeURIComponent(watcherId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ name })
    });
  }

  async getWatcherStatus(watcherId: string, session: string): Promise<WatcherStatus> {
    const data = await http<any>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/status`
    );
    return {
      user: data.user,
      host: data.host,
      cwd: data.cwd,
      fullCwd: data.fullCwd,
      condaEnv: data.condaEnv ?? null,
      dockerMode: data.dockerMode ?? null
    };
  }

  async getInitialLog(watcherId: string, session: string): Promise<TerminalLine[]> {
    const k = this.key(watcherId, session);
    this.logOffsets[k] = 0;
    const allLines: TerminalLine[] = [];
    const maxChunks = 30;
    const maxLines = 15000;
    let from = 0;
    for (let chunkCount = 0; chunkCount < maxChunks; chunkCount++) {
      const data = await http<{ lines?: string[]; nextOffset?: number; hasMore?: boolean }>(
        `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/log?fromOffset=${from}`
      );
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const nextOffset = typeof data.nextOffset === "number" ? data.nextOffset : from;
      for (let idx = 0; idx < lines.length; idx++) {
        const text = typeof lines[idx] === "string" ? lines[idx] : String(lines[idx] ?? "");
        allLines.push({ id: `init-${from}-${idx}`, text });
        if (allLines.length >= maxLines) break;
      }
      this.logOffsets[k] = nextOffset;
      if (!data.hasMore || allLines.length >= maxLines) break;
      from = nextOffset;
    }
    return allLines;
  }

  async sendRemoteCommand(
    watcherId: string,
    session: string,
    command: string
  ): Promise<{
    output?: string;
    exitCode?: number;
    _trace?: { method: "rt" | "commands_txt"; outputLineCount?: number; exitCode?: number };
  }> {
    const res = await http<{
      ok?: boolean;
      rt?: boolean;
      output?: string;
      exitCode?: number;
      _trace?: { method: "rt" | "commands_txt"; outputLineCount?: number; exitCode?: number };
    }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/commands`,
      { method: "POST", body: JSON.stringify({ command }) }
    );
    const trace = res?._trace;
    if (res?.ok === true) {
      return {
        output: res.output ?? "",
        exitCode: res.exitCode,
        _trace: trace,
      };
    }
    return { _trace: trace };
  }

  async fetchLogTail(watcherId: string, session: string): Promise<TerminalLine[]> {
    const k = this.key(watcherId, session);
    const from = this.logOffsets[k] ?? 0;
    const data = await http<{ lines?: string[]; nextOffset?: number }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/log?fromOffset=${from}`
    );
    const lines = Array.isArray(data.lines) ? data.lines : [];
    this.logOffsets[k] = typeof data.nextOffset === "number" ? data.nextOffset : from;
    return lines.map((text, idx) => ({
      id: `${Date.now()}-${from}-${idx}`,
      text: typeof text === "string" ? text : String(text ?? "")
    }));
  }

  async listFiles(watcherId: string, session: string): Promise<FileEntry[]> {
    return http<FileEntry[]>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/files?path=/`
    );
  }

  async listChildren(
    watcherId: string,
    session: string,
    path: string
  ): Promise<FileEntry[]> {
    return http<FileEntry[]>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/files/children?path=${encodeURIComponent(path)}`
    );
  }

  async createSymlink(
    watcherId: string,
    session: string,
    sourcePath: string,
    linkName: string
  ): Promise<void> {
    await http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/links`,
      {
        method: "POST",
        body: JSON.stringify({ sourcePath, linkName })
      }
    );
  }

  async createPath(
    watcherId: string,
    session: string,
    path: string,
    kind: "file" | "dir"
  ): Promise<{ ok: boolean; rt?: boolean }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/files`,
      { method: "POST", body: JSON.stringify({ path, kind }) }
    );
  }

  async deletePath(
    watcherId: string,
    session: string,
    path: string
  ): Promise<{ ok: boolean; rt?: boolean }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    );
  }

  async copyPath(
    watcherId: string,
    session: string,
    sourcePath: string,
    destPath: string
  ): Promise<{ ok: boolean; rt?: boolean }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/files/copy`,
      { method: "POST", body: JSON.stringify({ sourcePath, destPath }) }
    );
  }

  async movePath(
    watcherId: string,
    session: string,
    sourcePath: string,
    destPath: string
  ): Promise<{ ok: boolean; rt?: boolean }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/files/move`,
      { method: "POST", body: JSON.stringify({ sourcePath, destPath }) }
    );
  }

  async uploadFile(
    watcherId: string,
    session: string,
    path: string,
    contentBase64: string
  ): Promise<{ ok: boolean; rt?: boolean }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/files/upload`,
      { method: "POST", body: JSON.stringify({ path, contentBase64 }) }
    );
  }

  async fetchFileContent(
    watcherId: string,
    session: string,
    path: string
  ): Promise<string> {
    const data = await http<{ path: string; content: string }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/file?path=${encodeURIComponent(path)}`
    );
    return data.content;
  }

  async fetchFileChunk(
    watcherId: string,
    session: string,
    path: string,
    offset: number,
    length = 300000
  ): Promise<{ content: string; nextOffset: number; hasMore: boolean; totalSize: number }> {
    const data = await http<{
      content: string;
      nextOffset: number;
      hasMore: boolean;
      totalSize: number;
    }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/file-chunk?path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`
    );
    return data;
  }

  async saveFileContent(
    watcherId: string,
    session: string,
    path: string,
    content: string
  ): Promise<void> {
    await http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/file`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content })
      }
    );
  }

  getRawFileUrl(watcherId: string, session: string, path: string): string {
    return `${BACKEND_URL}/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
      session
    )}/file-raw?path=${encodeURIComponent(path)}`;
  }

  /** 画像プレビュー用: file-raw を fetch して Blob で返す（タイムアウト・エラー処理用） */
  async getRawFileBlob(
    watcherId: string,
    session: string,
    path: string,
    signal?: AbortSignal
  ): Promise<Blob> {
    const url = this.getRawFileUrl(watcherId, session, path);
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 28000);
    try {
      const res = await fetch(url, { signal: signal ?? ctrl.signal });
      if (!res.ok) throw new Error(`file-raw ${res.status}`);
      return res.blob();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getAiModels(
    watcherId: string,
    session: string
  ): Promise<{ installed: string[]; suggested: string[]; recommended?: string[]; provider?: string }> {
    return http<{ installed: string[]; suggested: string[]; recommended?: string[]; provider?: string }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/ai-models`
    );
  }

  async ensureAiModel(watcherId: string, session: string, model: string): Promise<{ ok: boolean }> {
    return http<{ ok: boolean }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/ai-ensure-model`,
      { method: "POST", body: JSON.stringify({ model }) }
    );
  }

  async ensureAiModelStream(
    watcherId: string,
    session: string,
    model: string,
    onProgress: (ev: { status?: string; percent?: number; error?: string }) => void
  ): Promise<{ ok: boolean }> {
    const path = `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/ai-ensure-model-stream`;
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body");
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = line.match(/^data:\s*(.+)$/s);
          if (!m) continue;
          try {
            const ev = JSON.parse(m[1].trim()) as { status?: string; percent?: number; error?: string };
            onProgress(ev);
            if (ev.status === "error") throw new Error(ev.error ?? "Pull failed");
            if (ev.status === "success") return { ok: true };
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      if (buf.trim()) {
        const m = buf.match(/^data:\s*(.+)$/s);
        if (m) {
          try {
            const ev = JSON.parse(m[1].trim()) as { status?: string; percent?: number; error?: string };
            onProgress(ev);
            if (ev.status === "success") return { ok: true };
          } catch {
            /* ignore */
          }
        }
      }
      return { ok: true };
    } finally {
      reader.releaseLock();
    }
  }

  async runAiAssist(
    watcherId: string,
    session: string,
    payload: {
      path: string;
      action: string;
      prompt: string;
      selectedText?: string;
      fileContent: string;
      history?: { role: string; content: string }[];
      model?: string;
      mode?: string;
      editorPath?: string;
      editorSelectedText?: string;
      editorContent?: string;
      thinking?: string;
      persona?: string;
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ result: string; command?: string; needsApproval?: boolean; logs?: { command: string; exitCode?: number; output?: string; error?: string }[] }> {
    return http<{ result: string; command?: string; needsApproval?: boolean; logs?: { command: string; exitCode?: number; output?: string; error?: string }[] }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/ai-assist`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        signal: options?.signal
      }
    );
  }

  async streamAi(
    watcherId: string,
    session: string,
    payload: {
      path: string;
      action: string;
      prompt: string;
      selectedText?: string;
      fileContent: string;
      history?: { role: string; content: string }[];
      model?: string;
      mode?: string;
      editorPath?: string;
      editorSelectedText?: string;
      editorContent?: string;
      thinking?: string;
      persona?: string;
      hybridRouting?: boolean;
    },
    onEvent: (ev: {
      type: "token" | "done" | "debate_turn";
      delta?: string;
      result?: string;
      command?: string;
      needsApproval?: boolean;
      truncated?: boolean;
      autoContinued?: boolean;
      logs?: { command: string; exitCode?: number; output?: string; error?: string }[];
      debates?: {
        id: string;
        title?: string;
        models: string[];
        turns: { round: number; speaker: string; model: string; role: string; content: string }[];
      }[];
      debateId?: string;
      turn?: { round: number; speaker: string; model: string; role: string; content: string };
    }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    const path = `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
      session
    )}/ai-stream`;
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options?.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const m = part.match(/^data:\s*(.+)$/s);
          if (!m) continue;
          try {
            const ev = JSON.parse(m[1].trim());
            if (ev && typeof ev.type === "string") {
              onEvent(ev);
            }
          } catch {
            // ignore malformed events
          }
        }
      }
      if (buf.trim()) {
        const m = buf.match(/^data:\s*(.+)$/s);
        if (m) {
          try {
            const ev = JSON.parse(m[1].trim());
            if (ev && typeof ev.type === "string") {
              onEvent(ev);
            }
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async sendAiBuddyFeedback(
    payload: {
      message: string;
      role: string;
      rating: "good" | "bad";
      taskType?: string;
      mode?: string;
      thinking?: string;
      model?: string;
      watcherId?: string;
      session?: string;
    }
  ): Promise<{ ok: boolean }> {
    return http<{ ok: boolean }>("/ai/buddy/feedback", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async getAiBuddyState(): Promise<BuddyState> {
    return http<BuddyState>("/ai/buddy/state");
  }

  async getAiInlineCompletion(
    watcherId: string,
    session: string,
    payload: { path: string; prefix: string; suffix: string; language?: string; model?: string }
  ): Promise<{ completion: string }> {
    return http<{ completion: string }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/ai-inline`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );
  }

  async getRunnerConfig(watcherId: string, session: string): Promise<RunnerConfig | null> {
    const data = await http<RunnerConfig | null>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/runner-config`
    );
    return data;
  }

  async updateRunnerConfig(
    watcherId: string,
    session: string,
    config: RunnerConfig
  ): Promise<void> {
    await http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/runner-config`,
      {
        method: "PUT",
        body: JSON.stringify({
          mode: config.mode,
          containerName: config.containerName,
          image: config.image,
          mountPath: config.mountPath,
          extraArgs: config.extraArgs
        })
      }
    );
  }

  async getRtStatus(watcherId: string): Promise<{
    registry_root: string;
    rt_port_file_exists: boolean;
    rt_port: number | null;
  }> {
    return http(`/watchers/${encodeURIComponent(watcherId)}/rt-status`);
  }

  async getDebugRt(watcherId: string, session: string): Promise<{
    ok: boolean;
    error?: string;
    port?: number | null;
    response?: unknown;
  }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/debug/rt`
    );
  }

  async cleanupStagedCache(
    watcherId: string,
    session: string
  ): Promise<{
    deleted: number;
    failed?: number;
    watcher_cleaned: boolean;
    relay_session_exists?: boolean;
  }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/cleanup-staged`,
      { method: "POST" }
    );
  }

  async getGpuStatus(
    watcherId: string,
    session: string
  ): Promise<{ output: string; error?: string; ok: boolean; exitCode?: number; source: "nvitop" | "nvidia-smi"; data?: unknown }> {
    return http(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/gpu-status`
    );
  }
}

export const api: SyncApi = new HttpSyncApi();

