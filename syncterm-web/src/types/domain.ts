export type RunnerMode = "host" | "docker_run" | "docker_exec";

export interface RunnerConfig {
  mode: RunnerMode;
  containerName?: string;
  image?: string;
  mountPath?: string;
  extraArgs?: string;
}

export interface WatcherInfo {
  id: string;
  displayName: string;
  lastHeartbeat: number;
}

export interface SessionInfo {
  name: string;
  watcherId: string;
}

export type FileKind = "file" | "dir" | "symlink";

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  kind: FileKind;
  hasChildren?: boolean;
  isRemoteLink?: boolean;
  children?: FileEntry[];
}

export interface WatcherStatus {
  user: string;
  host: string;
  cwd: string;
  fullCwd: string;
  condaEnv?: string | null;
  dockerMode?: string;
}

export interface TerminalLine {
  id: string;
  text: string;
  isSystem?: boolean;
}

