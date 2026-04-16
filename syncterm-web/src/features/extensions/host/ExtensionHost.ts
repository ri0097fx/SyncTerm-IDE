import type { ExtensionManifest } from "../../../types/domain";
import type {
  HostToWorkerMessage,
  RuntimeCommandDef,
  RuntimePanelDef,
  RuntimePanelModel,
  WorkerToHostMessage
} from "./hostProtocol";
import { resolveBuiltinEntry } from "./builtinEntries";

const STORAGE_PREFIX = "syncterm.ext.";
const COMMAND_TIMEOUT_MS = 15000;

export interface ExtensionHostEvents {
  onReady: (extensionId: string) => void;
  onRegisterCommand: (extensionId: string, command: RuntimeCommandDef) => void;
  onRegisterPanel: (extensionId: string, panel: RuntimePanelDef) => void;
  onPanelStateUpdate: (extensionId: string, panelId: string, model: RuntimePanelModel) => void;
  onCommandResult: (extensionId: string, payload: { ok: boolean; message?: string; openPanelId?: string }) => void;
  onError: (extensionId: string, message: string) => void;
}

export class ExtensionHost {
  private workers = new Map<string, Worker>();
  private pending = new Map<string, { extensionId: string; timer: number }>();
  private events: ExtensionHostEvents;

  constructor(events: ExtensionHostEvents) {
    this.events = events;
  }

  dispose() {
    for (const worker of this.workers.values()) worker.terminate();
    this.workers.clear();
    for (const p of this.pending.values()) window.clearTimeout(p.timer);
    this.pending.clear();
  }

  private storageKey(extensionId: string): string {
    return `${STORAGE_PREFIX}${extensionId}`;
  }

  private readStorage(extensionId: string): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(this.storageKey(extensionId));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeStorage(extensionId: string, key: string, value: unknown) {
    const current = this.readStorage(extensionId);
    current[key] = value;
    try {
      localStorage.setItem(this.storageKey(extensionId), JSON.stringify(current));
    } catch (err) {
      console.error(`[ExtensionHost] Storage write failed for ${extensionId}/${key}:`, err);
      this.events.onError(extensionId, `Storage quota exceeded for key "${key}"`);
    }
  }

  startExtension(manifest: ExtensionManifest): boolean {
    if (manifest.runtime !== "sandbox-runtime") return false;
    const entryCode = manifest.entryCode || (manifest.entry ? resolveBuiltinEntry(manifest.entry) : null);
    if (!entryCode) {
      this.events.onError(manifest.id, "Entry code not found.");
      return false;
    }

    const existing = this.workers.get(manifest.id);
    if (existing) existing.terminate();

    const worker = new Worker(new URL("./worker/extensionWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<WorkerToHostMessage>) => this.handleWorkerMessage(ev.data);
    worker.onerror = (ev) => {
      this.events.onError(manifest.id, `Worker crashed: ${ev.message}`);
    };
    this.workers.set(manifest.id, worker);
    const msg: HostToWorkerMessage = {
      type: "init",
      extensionId: manifest.id,
      entryCode,
      manifest: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        permissions: manifest.permissions ?? []
      },
      initialStorage: this.readStorage(manifest.id)
    };
    worker.postMessage(msg);
    return true;
  }

  stopExtension(extensionId: string) {
    const worker = this.workers.get(extensionId);
    if (!worker) return;
    worker.postMessage({ type: "dispose" } satisfies HostToWorkerMessage);
    worker.terminate();
    this.workers.delete(extensionId);
  }

  executeCommand(extensionId: string, command: string, args?: unknown[]) {
    const worker = this.workers.get(extensionId);
    if (!worker) {
      console.warn(`[ExtensionHost] Worker not found for "${extensionId}". Active workers:`, [...this.workers.keys()]);
      this.events.onError(extensionId, `Extension host not running: ${extensionId}`);
      return;
    }
    const requestId = `${extensionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => {
      this.pending.delete(requestId);
      console.warn(`[ExtensionHost] Command timeout (${COMMAND_TIMEOUT_MS}ms): ${command}`);
      this.events.onError(extensionId, `Command timeout: ${command}`);
    }, COMMAND_TIMEOUT_MS);
    this.pending.set(requestId, { extensionId, timer });
    worker.postMessage({
      type: "executeCommand",
      requestId,
      command,
      args
    } satisfies HostToWorkerMessage);
  }

  private handleWorkerMessage(msg: WorkerToHostMessage) {
    if (msg.type === "ready") {
      this.events.onReady(msg.extensionId);
      return;
    }
    if (msg.type === "registerCommand") {
      this.events.onRegisterCommand(msg.extensionId, msg.command);
      return;
    }
    if (msg.type === "registerPanel") {
      this.events.onRegisterPanel(msg.extensionId, msg.panel);
      return;
    }
    if (msg.type === "panelStateUpdate") {
      this.events.onPanelStateUpdate(msg.extensionId, msg.panelId, msg.model);
      return;
    }
    if (msg.type === "storageSet") {
      this.writeStorage(msg.extensionId, msg.key, msg.value);
      return;
    }
    if (msg.type === "commandResult") {
      const pending = this.pending.get(msg.requestId);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(msg.requestId);
      }
      this.events.onCommandResult(msg.extensionId, {
        ok: msg.ok,
        message: msg.message,
        openPanelId: msg.openPanelId
      });
      return;
    }
    if (msg.type === "error") {
      this.events.onError(msg.extensionId, `${msg.phase}: ${msg.message}`);
    }
  }
}
