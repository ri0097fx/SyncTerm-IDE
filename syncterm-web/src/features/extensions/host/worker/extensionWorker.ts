/// <reference lib="webworker" />

import type {
  HostToWorkerMessage,
  RuntimeCommandDef,
  RuntimePanelDef,
  RuntimePanelModel,
  WorkerToHostMessage
} from "../hostProtocol";

declare const self: DedicatedWorkerGlobalScope;

type CommandHandler = (...args: unknown[]) => unknown;

let extensionId = "";
let commands = new Map<string, { meta: RuntimeCommandDef; handler: CommandHandler }>();
let panels = new Map<string, RuntimePanelDef>();
let storage = new Map<string, unknown>();

function post(msg: WorkerToHostMessage) {
  self.postMessage(msg);
}

function postError(phase: "init" | "execute" | "runtime", err: unknown) {
  const error = err instanceof Error ? err : new Error(String(err));
  post({
    type: "error",
    extensionId,
    phase,
    message: error.message,
    stack: error.stack
  });
}

function registerCommand(meta: RuntimeCommandDef, handler: CommandHandler) {
  if (!meta.command) throw new Error("command id is required");
  commands.set(meta.command, { meta, handler });
  post({ type: "registerCommand", extensionId, command: meta });
}

function registerPanel(panel: RuntimePanelDef) {
  if (!panel.id) throw new Error("panel id is required");
  panels.set(panel.id, panel);
  post({ type: "registerPanel", extensionId, panel });
}

function updatePanelState(panelId: string, model: RuntimePanelModel) {
  if (!panels.has(panelId)) return;
  post({ type: "panelStateUpdate", extensionId, panelId, model });
}

function buildApi() {
  return {
    registerCommand,
    registerPanel,
    updatePanelState,
    now: () => Date.now(),
    random: (min = 0, max = 1) => min + Math.random() * (max - min),
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: unknown) => {
        storage.set(key, value);
        post({ type: "storageSet", extensionId, key, value });
      }
    }
  };
}

async function handleInit(msg: Extract<HostToWorkerMessage, { type: "init" }>) {
  extensionId = msg.extensionId;
  commands = new Map();
  panels = new Map();
  storage = new Map(Object.entries(msg.initialStorage ?? {}));
  try {
    const api = buildApi();
    const manifest = msg.manifest;
    const code = `${msg.entryCode}\n\n;return (typeof activate === "function") ? activate : null;`;
    const factory = new Function("api", "manifest", code) as (
      api: ReturnType<typeof buildApi>,
      manifest: unknown
    ) => ((api: ReturnType<typeof buildApi>, manifest: unknown) => unknown) | null;
    const activateFn = factory(api, manifest);
    if (typeof activateFn === "function") {
      await Promise.resolve(activateFn(api, manifest));
    }
    post({ type: "ready", extensionId });
  } catch (err) {
    postError("init", err);
  }
}

async function handleExecute(msg: Extract<HostToWorkerMessage, { type: "executeCommand" }>) {
  try {
    const item = commands.get(msg.command);
    if (!item) {
      console.warn(`[Worker:${extensionId}] Command not found: "${msg.command}". Registered:`, [...commands.keys()]);
      post({
        type: "commandResult",
        extensionId,
        requestId: msg.requestId,
        ok: false,
        message: `Command not found: ${msg.command}`
      });
      return;
    }
    const raw = await Promise.resolve(item.handler(...(msg.args ?? [])));
    const result = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    post({
      type: "commandResult",
      extensionId,
      requestId: msg.requestId,
      ok: true,
      message: typeof result.message === "string" ? result.message : undefined,
      openPanelId: typeof result.openPanelId === "string" ? result.openPanelId : undefined
    });
  } catch (err) {
    postError("execute", err);
    const error = err instanceof Error ? err : new Error(String(err));
    post({
      type: "commandResult",
      extensionId,
      requestId: msg.requestId,
      ok: false,
      message: error.message
    });
  }
}

self.onmessage = (ev: MessageEvent<HostToWorkerMessage>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    void handleInit(msg);
    return;
  }
  if (msg.type === "executeCommand") {
    void handleExecute(msg);
    return;
  }
  if (msg.type === "dispose") {
    self.close();
  }
};
