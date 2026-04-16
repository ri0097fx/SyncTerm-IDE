export interface RuntimeCommandDef {
  command: string;
  title: string;
  description?: string;
}

export interface RuntimePanelAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface RuntimePanelModel {
  markdown?: string;
  items?: string[];
  stats?: Record<string, string | number>;
  actions?: RuntimePanelAction[];
}

export interface RuntimePanelDef {
  id: string;
  title: string;
  model?: RuntimePanelModel;
}

export type HostToWorkerMessage =
  | {
      type: "init";
      extensionId: string;
      entryCode: string;
      manifest: {
        id: string;
        name: string;
        version: string;
        permissions?: string[];
      };
      initialStorage: Record<string, unknown>;
    }
  | {
      type: "executeCommand";
      requestId: string;
      command: string;
      args?: unknown[];
    }
  | {
      type: "dispose";
    };

export type WorkerToHostMessage =
  | { type: "ready"; extensionId: string }
  | { type: "registerCommand"; extensionId: string; command: RuntimeCommandDef }
  | { type: "registerPanel"; extensionId: string; panel: RuntimePanelDef }
  | {
      type: "panelStateUpdate";
      extensionId: string;
      panelId: string;
      model: RuntimePanelModel;
    }
  | {
      type: "commandResult";
      extensionId: string;
      requestId: string;
      ok: boolean;
      message?: string;
      openPanelId?: string;
    }
  | {
      type: "storageSet";
      extensionId: string;
      key: string;
      value: unknown;
    }
  | {
      type: "error";
      extensionId: string;
      phase: "init" | "execute" | "runtime";
      message: string;
      stack?: string;
    };
