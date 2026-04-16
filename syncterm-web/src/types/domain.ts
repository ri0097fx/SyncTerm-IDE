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

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  longDescription?: string | null;
  categories: string[];
  tags: string[];
  icon?: string | null;
  previewTitle?: string | null;
  previewBullets?: string[];
  previewMock?: string[];
  repository?: string | null;
  runtime?: "manifest-only" | "sandbox-runtime";
  permissions?: string[];
  entry?: string | null;
  entryCode?: string | null;
  activationEvents: string[];
  contributes: Record<string, unknown>;
}

export interface ExtensionCommandContribution {
  command: string;
  title: string;
  panelId?: string;
  message?: string;
}

export interface ExtensionPanelContribution {
  id: string;
  title: string;
  markdown?: string;
}

export interface ExtensionCatalogEntry {
  manifest: ExtensionManifest;
  source: string;
  downloadUrl?: string | null;
}

export interface ExtensionInstallState {
  extensionId: string;
  installedVersion: string;
  installedAt: number;
  enabled: boolean;
  pinned: boolean;
}

export interface ExtensionSessionState {
  sessionKey: string;
  enabled: Record<string, boolean>;
  order: string[];
  updatedAt: number;
}

export interface ExtensionApiListResponse {
  apiVersion: number;
  items: ExtensionCatalogEntry[];
}

export interface ExtensionApiInstalledResponse {
  apiVersion: number;
  items: ExtensionInstallState[];
}

export interface ExtensionApiSessionStateResponse {
  apiVersion: number;
  state: ExtensionSessionState;
}

export interface ExtensionHostContract {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => void;
  registerPanel: (id: string, opts: { title: string }) => void;
}

