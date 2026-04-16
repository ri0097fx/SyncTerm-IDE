import { useCallback, useRef } from "react";
import { api } from "../../lib/api";
import type { ExtensionSessionState } from "../../types/domain";

function defaultSessionState(sessionKey: string): ExtensionSessionState {
  return { sessionKey, enabled: {}, order: [], updatedAt: Date.now() / 1000 };
}

/**
 * Serialises enable/disable API calls and manages optimistic UI updates.
 *
 * Design: optimistic-only, no server resync.
 *  – Each toggle immediately applies a functional state update (always
 *    sees the latest state).
 *  – API calls are serialised via a promise queue so the backend's
 *    read-modify-write never races.
 *  – On API error the specific toggle is reverted.
 *  – No final "fetch server state" is performed, eliminating the class
 *    of bugs where a stale server response overwrites a newer optimistic
 *    update.
 */
export function useExtensionToggleQueue(
  watcherId: string | undefined,
  sessionName: string | undefined,
  setSessionState: React.Dispatch<React.SetStateAction<ExtensionSessionState | null>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueToggle = useCallback(
    (extensionId: string, enabled: boolean) => {
      if (!watcherId || !sessionName) return;
      const sk = `${watcherId}/${sessionName}`;

      // Optimistic update (functional – always based on latest state)
      setSessionState((cur) => {
        const base = cur ?? defaultSessionState(sk);
        return {
          ...base,
          enabled: { ...base.enabled, [extensionId]: enabled },
          order: base.order.includes(extensionId)
            ? base.order
            : [...base.order, extensionId],
          updatedAt: Date.now() / 1000,
        };
      });

      // Serialised API call
      const job = queueRef.current.then(async () => {
        try {
          if (enabled) {
            await api.enableSessionExtension(watcherId, sessionName, extensionId);
          } else {
            await api.disableSessionExtension(watcherId, sessionName, extensionId);
          }
          setError(null);
        } catch (e) {
          // Revert only this specific toggle
          setSessionState((cur) => {
            const base = cur ?? defaultSessionState(sk);
            return {
              ...base,
              enabled: { ...base.enabled, [extensionId]: !enabled },
              updatedAt: Date.now() / 1000,
            };
          });
          setError(e instanceof Error ? e.message : "有効化状態の更新に失敗しました");
        }
      });
      queueRef.current = job;
    },
    [watcherId, sessionName, setSessionState, setError],
  );

  const enqueueBulkToggle = useCallback(
    (updates: Array<{ extensionId: string; enabled: boolean }>) => {
      if (!watcherId || !sessionName || updates.length === 0) return;
      const sk = `${watcherId}/${sessionName}`;

      const merged = new Map<string, boolean>();
      for (const u of updates) merged.set(u.extensionId, !!u.enabled);

      // Optimistic bulk update
      setSessionState((cur) => {
        const base = cur ?? defaultSessionState(sk);
        const nextEnabled = { ...base.enabled };
        const nextOrder = base.order.slice();
        for (const [id, en] of merged) {
          nextEnabled[id] = en;
          if (!nextOrder.includes(id)) nextOrder.push(id);
        }
        return { ...base, enabled: nextEnabled, order: nextOrder, updatedAt: Date.now() / 1000 };
      });

      // Serialised API calls (one per extension, sequential)
      const job = queueRef.current.then(async () => {
        for (const [extensionId, enabled] of merged) {
          try {
            if (enabled) {
              await api.enableSessionExtension(watcherId, sessionName, extensionId);
            } else {
              await api.disableSessionExtension(watcherId, sessionName, extensionId);
            }
          } catch {
            // Revert this specific toggle on error
            setSessionState((cur) => {
              const base = cur ?? defaultSessionState(sk);
              return {
                ...base,
                enabled: { ...base.enabled, [extensionId]: !enabled },
                updatedAt: Date.now() / 1000,
              };
            });
          }
        }
      });
      queueRef.current = job;
    },
    [watcherId, sessionName, setSessionState],
  );

  return { enqueueToggle, enqueueBulkToggle } as const;
}
