import type {
  FileEntry,
  RunnerConfig,
  SessionInfo,
  TerminalLine,
  WatcherInfo,
  WatcherStatus
} from "../types/domain";

export interface SyncApi {
  listWatchers(): Promise<WatcherInfo[]>;
  listSessions(watcherId: string): Promise<SessionInfo[]>;
  getWatcherStatus(watcherId: string, session: string): Promise<WatcherStatus>;
  getInitialLog(watcherId: string, session: string): Promise<TerminalLine[]>;
  sendRemoteCommand(watcherId: string, session: string, command: string): Promise<void>;
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
  runAiAssist(
    watcherId: string,
    session: string,
    payload: { path: string; action: string; prompt: string; selectedText?: string; fileContent: string }
  ): Promise<{ result: string }>;
  getAiInlineCompletion(
    watcherId: string,
    session: string,
    payload: { path: string; prefix: string; suffix: string; language?: string }
  ): Promise<{ completion: string }>;

  getRunnerConfig(watcherId: string, session: string): Promise<RunnerConfig | null>;
  updateRunnerConfig(
    watcherId: string,
    session: string,
    config: RunnerConfig
  ): Promise<void>;

  /** 現在セッションの staged キャッシュを一括削除 */
  cleanupStagedCache(watcherId: string, session: string): Promise<{
    deleted: number;
    failed?: number;
    watcher_cleaned: boolean;
    relay_session_exists?: boolean;
  }>;
}

// --------------------------------------------------------------------------------
// HTTP 実装（FastAPI バックエンドと通信）
// --------------------------------------------------------------------------------

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";
const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL ?? "http://127.0.0.1:8011";

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
    return this.fetchLogTail(watcherId, session);
  }

  async sendRemoteCommand(
    watcherId: string,
    session: string,
    command: string
  ): Promise<void> {
    await http(`/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(session)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command })
    });
  }

  async fetchLogTail(watcherId: string, session: string): Promise<TerminalLine[]> {
    const k = this.key(watcherId, session);
    const from = this.logOffsets[k] ?? 0;
    const data = await http<{ lines: string[]; nextOffset: number }>(
      `/watchers/${encodeURIComponent(watcherId)}/sessions/${encodeURIComponent(
        session
      )}/log?fromOffset=${from}`
    );
    this.logOffsets[k] = data.nextOffset;
    return data.lines.map((text, idx) => ({
      id: `${Date.now()}-${from}-${idx}`,
      text
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

  async runAiAssist(
    watcherId: string,
    session: string,
    payload: { path: string; action: string; prompt: string; selectedText?: string; fileContent: string }
  ): Promise<{ result: string }> {
    return httpBase<{ result: string }>(
      AI_PROXY_URL,
      `/ai-assist`,
      {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          watcherId,
          session
        })
      }
    );
  }

  async getAiInlineCompletion(
    watcherId: string,
    session: string,
    payload: { path: string; prefix: string; suffix: string; language?: string }
  ): Promise<{ completion: string }> {
    return httpBase<{ completion: string }>(
      AI_PROXY_URL,
      `/ai-inline`,
      {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          watcherId,
          session
        })
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
}

export const api: SyncApi = new HttpSyncApi();

