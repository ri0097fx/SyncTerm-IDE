import React, { createContext, useContext, useEffect, useState } from "react";
import type { RunnerConfig, SessionInfo, WatcherInfo } from "../../types/domain";
import { api } from "../../lib/api";

interface SessionState {
  watchers: WatcherInfo[];
  sessions: SessionInfo[];
  currentWatcher?: WatcherInfo;
  currentSession?: SessionInfo;
  runnerConfig?: RunnerConfig | null;
  loading: boolean;
  setWatcher: (id: string) => void;
  setSession: (name: string) => void;
  refreshWatchers: () => void;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export const useSession = (): SessionState => {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
};

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [watchers, setWatchers] = useState<WatcherInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentWatcherId, setCurrentWatcherId] = useState<string | undefined>();
  const [currentSessionName, setCurrentSessionName] = useState<string | undefined>();
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig | null>();
  const [loading, setLoading] = useState(false);

  const loadWatchers = async () => {
    setLoading(true);
    try {
      const list = await api.listWatchers();
      setWatchers(list);
      if (!currentWatcherId && list.length > 0) {
        setCurrentWatcherId(list[0].id);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWatchers();
  }, []);

  useEffect(() => {
    const loadSessions = async () => {
      if (!currentWatcherId) {
        setSessions([]);
        return;
      }
      setLoading(true);
      try {
        const list = await api.listSessions(currentWatcherId);
        setSessions(list);
        if (!currentSessionName && list.length > 0) {
          setCurrentSessionName(list[0].name);
        }
      } finally {
        setLoading(false);
      }
    };
    void loadSessions();
  }, [currentWatcherId]);

  useEffect(() => {
    const loadRunner = async () => {
      if (!currentWatcherId || !currentSessionName) {
        setRunnerConfig(null);
        return;
      }
      try {
        const conf = await api.getRunnerConfig(currentWatcherId, currentSessionName);
        setRunnerConfig(conf);
      } catch {
        setRunnerConfig(null);
      }
    };
    void loadRunner();
  }, [currentWatcherId, currentSessionName]);

  const currentWatcher = watchers.find((w) => w.id === currentWatcherId);
  const currentSession = sessions.find(
    (s) => s.watcherId === currentWatcherId && s.name === currentSessionName
  );

  const value: SessionState = {
    watchers,
    sessions,
    currentWatcher,
    currentSession,
    runnerConfig,
    loading,
    setWatcher: (id) => {
      setCurrentWatcherId(id);
      setCurrentSessionName(undefined);
    },
    setSession: (name) => setCurrentSessionName(name),
    refreshWatchers: () => {
      void loadWatchers();
    }
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

