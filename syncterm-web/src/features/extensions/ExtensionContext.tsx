import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "../session/SessionContext";
import { api } from "../../lib/api";
import type { ExtensionCatalogEntry, ExtensionInstallState, ExtensionSessionState } from "../../types/domain";
import { useExtensionToggleQueue } from "./useExtensionToggleQueue";

interface ExtensionState {
  catalog: ExtensionCatalogEntry[];
  installed: ExtensionInstallState[];
  sessionState: ExtensionSessionState | null;
  loading: boolean;
  error: string | null;
  refreshAll: () => Promise<void>;
  installExtension: (extensionId: string) => Promise<void>;
  uninstallExtension: (extensionId: string) => Promise<void>;
  setSessionEnabled: (extensionId: string, enabled: boolean) => void;
  setSessionEnabledBulk: (updates: Array<{ extensionId: string; enabled: boolean }>) => void;
}

const ExtensionContext = createContext<ExtensionState | undefined>(undefined);

export const ExtensionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentWatcher, currentSession } = useSession();
  const [catalog, setCatalog] = useState<ExtensionCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<ExtensionInstallState[]>([]);
  const [sessionState, setSessionState] = useState<ExtensionSessionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable string IDs – avoids refreshAll recreation when the Session context
  // object reference changes but the selected watcher/session stays the same.
  const watcherId = currentWatcher?.id;
  const sessionName = currentSession?.name;

  /* ─── Toggle queue (serialises enable/disable API calls) ─── */
  const { enqueueToggle, enqueueBulkToggle } = useExtensionToggleQueue(
    watcherId,
    sessionName,
    setSessionState,
    setError,
  );

  /* ─── Refresh catalogue / installed / session state ─── */
  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogRes, installedRes] = await Promise.all([
        api.listExtensionCatalog(),
        api.listInstalledExtensions(),
      ]);
      setCatalog(catalogRes.items);
      setInstalled(installedRes.items);
      if (watcherId && sessionName) {
        const st = await api.getSessionExtensionState(watcherId, sessionName);
        setSessionState(st.state);
      } else {
        setSessionState(null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "拡張機能一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [watcherId, sessionName]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  /* ─── Install / uninstall ─── */
  const installExtension = useCallback(async (extensionId: string) => {
    const prev = installed;
    const catalogItem = catalog.find((x) => x.manifest.id === extensionId);
    if (!catalogItem) return;
    const optimistic: ExtensionInstallState = {
      extensionId,
      installedVersion: catalogItem.manifest.version,
      installedAt: Date.now() / 1000,
      enabled: true,
      pinned: false,
    };
    setInstalled((cur) => [...cur.filter((x) => x.extensionId !== extensionId), optimistic]);
    try {
      await api.installExtension(extensionId);
      const latest = await api.listInstalledExtensions();
      setInstalled(latest.items);
      setError(null);
    } catch (e) {
      setInstalled(prev);
      setError(e instanceof Error ? e.message : "インストールに失敗しました");
      throw e;
    }
  }, [catalog, installed]);

  const uninstallExtension = useCallback(async (extensionId: string) => {
    const prevInstalled = installed;
    const prevState = sessionState;
    setInstalled((cur) => cur.filter((x) => x.extensionId !== extensionId));
    setSessionState((cur) => {
      if (!cur) return cur;
      const nextEnabled = { ...cur.enabled };
      delete nextEnabled[extensionId];
      return { ...cur, enabled: nextEnabled, order: cur.order.filter((x) => x !== extensionId) };
    });
    try {
      await api.uninstallExtension(extensionId);
      const latest = await api.listInstalledExtensions();
      setInstalled(latest.items);
      if (watcherId && sessionName) {
        const st = await api.getSessionExtensionState(watcherId, sessionName);
        setSessionState(st.state);
      }
      setError(null);
    } catch (e) {
      setInstalled(prevInstalled);
      setSessionState(prevState);
      setError(e instanceof Error ? e.message : "アンインストールに失敗しました");
      throw e;
    }
  }, [watcherId, sessionName, installed, sessionState]);

  /* ─── Context value ─── */
  const value = useMemo<ExtensionState>(() => ({
    catalog,
    installed,
    sessionState,
    loading,
    error,
    refreshAll,
    installExtension,
    uninstallExtension,
    setSessionEnabled: enqueueToggle,
    setSessionEnabledBulk: enqueueBulkToggle,
  }), [catalog, installed, sessionState, loading, error, refreshAll, installExtension, uninstallExtension, enqueueToggle, enqueueBulkToggle]);

  return <ExtensionContext.Provider value={value}>{children}</ExtensionContext.Provider>;
};

export function useExtensions(): ExtensionState {
  const ctx = useContext(ExtensionContext);
  if (!ctx) throw new Error("useExtensions must be used within ExtensionProvider");
  return ctx;
}
