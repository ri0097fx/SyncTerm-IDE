import React, { createContext, useCallback, useContext, useRef, useState } from "react";

export interface ActiveEditorState {
  path: string | null;
  content: string;
  selectedText: string;
}

interface ActiveEditorContextValue {
  activeEditor: ActiveEditorState;
  setActiveEditorState: (state: Partial<ActiveEditorState>) => void;
  registerApplyToSelection: (fn: ((text: string) => void) | null) => void;
  registerAppendAtCursor: (fn: ((text: string) => void) | null) => void;
  applyToSelection: (text: string) => void;
  appendAtCursor: (text: string) => void;
  /** AI チャットの「承認して保存」後にエディタ／タブの内容を同期する（EditorPanel が登録） */
  registerFileAppliedFromAi: (fn: ((sessionRelPath: string, content: string) => void) | null) => void;
  notifyFileAppliedFromAi: (sessionRelPath: string, content: string) => void;
}

const defaultState: ActiveEditorState = {
  path: null,
  content: "",
  selectedText: ""
};

const ActiveEditorContext = createContext<ActiveEditorContextValue | null>(null);

export function ActiveEditorProvider({ children }: { children: React.ReactNode }) {
  const [activeEditor, setState] = useState<ActiveEditorState>(defaultState);
  const applyRef = useRef<((text: string) => void) | null>(null);
  const appendRef = useRef<((text: string) => void) | null>(null);
  const fileAppliedFromAiRef = useRef<((sessionRelPath: string, content: string) => void) | null>(null);

  const setActiveEditorState = useCallback((patch: Partial<ActiveEditorState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const registerApplyToSelection = useCallback((fn: ((text: string) => void) | null) => {
    applyRef.current = fn;
  }, []);

  const registerAppendAtCursor = useCallback((fn: ((text: string) => void) | null) => {
    appendRef.current = fn;
  }, []);

  const applyToSelection = useCallback((text: string) => {
    applyRef.current?.(text);
  }, []);

  const appendAtCursor = useCallback((text: string) => {
    appendRef.current?.(text);
  }, []);

  const registerFileAppliedFromAi = useCallback(
    (fn: ((sessionRelPath: string, content: string) => void) | null) => {
      fileAppliedFromAiRef.current = fn;
    },
    []
  );

  const notifyFileAppliedFromAi = useCallback((sessionRelPath: string, content: string) => {
    fileAppliedFromAiRef.current?.(sessionRelPath, content);
  }, []);

  const value: ActiveEditorContextValue = {
    activeEditor,
    setActiveEditorState,
    registerApplyToSelection,
    registerAppendAtCursor,
    applyToSelection,
    appendAtCursor,
    registerFileAppliedFromAi,
    notifyFileAppliedFromAi
  };

  return (
    <ActiveEditorContext.Provider value={value}>
      {children}
    </ActiveEditorContext.Provider>
  );
}

export function useActiveEditor(): ActiveEditorContextValue {
  const ctx = useContext(ActiveEditorContext);
  if (!ctx) throw new Error("useActiveEditor must be used within ActiveEditorProvider");
  return ctx;
}
