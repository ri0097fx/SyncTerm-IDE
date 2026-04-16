import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useExtensions } from "./ExtensionContext";
import type { ExtensionCatalogEntry } from "../../types/domain";
import type { RuntimePanelAction } from "./host/hostProtocol";
import { ExtensionHost } from "./host/ExtensionHost";

export interface RuntimeCommand {
  extensionId: string;
  command: string;
  title: string;
  description?: string;
}

export interface RuntimePanel {
  extensionId: string;
  id: string;
  title: string;
  model?: {
    markdown?: string;
    items?: string[];
    stats?: Record<string, string | number>;
    actions?: RuntimePanelAction[];
  };
}

interface ExtensionRuntimeState {
  commands: RuntimeCommand[];
  panels: RuntimePanel[];
  runtimeErrors: Record<string, string>;
  readyExtensions: string[];
  activePanelId: string | null;
  lastCommandMessage: string | null;
  runCommand: (command: string, args?: unknown[]) => void;
  execDirect: (extensionId: string, command: string, args?: unknown[]) => void;
  openPanel: (panelId: string) => void;
  closePanel: () => void;
}

const ExtensionRuntimeContext = createContext<ExtensionRuntimeState | undefined>(undefined);

function getEnabledEntries(
  catalog: ExtensionCatalogEntry[],
  installedIds: Set<string>,
  enabledMap: Record<string, boolean>
): ExtensionCatalogEntry[] {
  return catalog.filter((entry) => installedIds.has(entry.manifest.id) && enabledMap[entry.manifest.id] === true);
}

export const ExtensionRuntimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { catalog, installed, sessionState } = useExtensions();
  const hostRef = useRef<ExtensionHost | null>(null);
  const [commands, setCommands] = useState<RuntimeCommand[]>([]);
  const [panels, setPanels] = useState<RuntimePanel[]>([]);
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});
  const [readyExtensions, setReadyExtensions] = useState<string[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const activePanelIdRef = useRef<string | null>(null);
  const [lastCommandMessage, setLastCommandMessage] = useState<string | null>(null);

  const enabledEntries = useMemo(() => {
    const installedIds = new Set(installed.map((x) => x.extensionId));
    const enabledMap = sessionState?.enabled ?? {};
    return getEnabledEntries(catalog, installedIds, enabledMap);
  }, [catalog, installed, sessionState?.enabled]);

  const panelIds = useMemo(() => new Set(panels.map((p) => p.id)), [panels]);

  const safeActivePanelId = activePanelId && panelIds.has(activePanelId) ? activePanelId : null;
  useEffect(() => {
    activePanelIdRef.current = safeActivePanelId;
  }, [safeActivePanelId]);
  useEffect(() => {
    if (activePanelId && !panelIds.has(activePanelId)) {
      setActivePanelId(null);
    }
  }, [activePanelId, panelIds]);

  useEffect(() => {
    const host = new ExtensionHost({
      onReady: (extensionId) => {
        setReadyExtensions((prev) => (prev.includes(extensionId) ? prev : [...prev, extensionId]));
      },
      onRegisterCommand: (extensionId, command) => {
        setCommands((prev) => {
          const filtered = prev.filter((x) => x.command !== command.command);
          return [...filtered, { extensionId, command: command.command, title: command.title, description: command.description }]
            .sort((a, b) => a.title.localeCompare(b.title));
        });
      },
      onRegisterPanel: (extensionId, panel) => {
        setPanels((prev) => {
          const filtered = prev.filter((x) => x.id !== panel.id);
          return [...filtered, { extensionId, id: panel.id, title: panel.title, model: panel.model }];
        });
        if (!activePanelIdRef.current && extensionId.startsWith("game.")) {
          setActivePanelId(panel.id);
        }
      },
      onPanelStateUpdate: (extensionId, panelId, model) => {
        setPanels((prev) => {
          const idx = prev.findIndex((x) => x.id === panelId);
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = { ...next[idx], extensionId, model };
          return next;
        });
      },
      onCommandResult: (_extensionId, payload) => {
        if (payload.openPanelId) setActivePanelId(payload.openPanelId);
        if (payload.message) setLastCommandMessage(payload.message);
      },
      onError: (extensionId, message) => {
        setRuntimeErrors((prev) => ({ ...prev, [extensionId]: message }));
        setLastCommandMessage(`${extensionId}: ${message}`);
      }
    });
    hostRef.current = host;
    return () => {
      host.dispose();
      hostRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.dispose();
    setCommands([]);
    setPanels([]);
    setRuntimeErrors({});
    setReadyExtensions([]);
    const enabledRuntimeEntries = enabledEntries.filter((x) => (x.manifest.runtime ?? "manifest-only") === "sandbox-runtime");
    for (const entry of enabledRuntimeEntries) {
      host.startExtension(entry.manifest);
    }
  }, [enabledEntries]);

  const runCommand = (commandId: string, args?: unknown[]) => {
    const cmd = commands.find((x) => x.command === commandId);
    if (!cmd) {
      setLastCommandMessage(`Command not found: ${commandId}`);
      return;
    }
    hostRef.current?.executeCommand(cmd.extensionId, cmd.command, args);
  };

  const execDirect = (extensionId: string, command: string, args?: unknown[]) => {
    hostRef.current?.executeCommand(extensionId, command, args);
  };

  const value: ExtensionRuntimeState = {
    commands,
    panels,
    runtimeErrors,
    readyExtensions,
    activePanelId: safeActivePanelId,
    lastCommandMessage,
    runCommand,
    execDirect,
    openPanel: (panelId) => {
      if (panelIds.has(panelId)) setActivePanelId(panelId);
    },
    closePanel: () => setActivePanelId(null)
  };

  return <ExtensionRuntimeContext.Provider value={value}>{children}</ExtensionRuntimeContext.Provider>;
};

export function useExtensionRuntime(): ExtensionRuntimeState {
  const ctx = useContext(ExtensionRuntimeContext);
  if (!ctx) throw new Error("useExtensionRuntime must be used within ExtensionRuntimeProvider");
  return ctx;
}
