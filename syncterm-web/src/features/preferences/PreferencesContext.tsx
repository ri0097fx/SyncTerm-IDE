import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type AppTheme = "dark" | "light" | "spyder";
export type UiDensity = "comfortable" | "compact";
export type EditorTheme = "vs-dark" | "vs-light" | "spyder";
export type EditorKeymap = "vscode" | "spyder";

export interface Preferences {
  theme: AppTheme;
  uiDensity: UiDensity;
  editorTheme: EditorTheme;
  editorKeymap: EditorKeymap;
  editorFontSize: number;
  editorFontFamily: string;
  editorWordWrap: "off" | "on";
  editorLineNumbers: boolean;
  editorMinimap: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalMaxLines: number;
  terminalPollMs: number;
   /** AI チャット／AIアシスト用のフォントサイズ（px） */
  aiFontSize: number;
  /** AI へのペルソナ／追加指示（システムプロンプトに付与） */
  aiPersona: string;
  /** AI 応答の口調 */
  aiTone: "neutral" | "friendly" | "strict";
  /** 応答のボリューム感 */
  aiResponseLength: "short" | "normal" | "detailed";
  /** 応答に使う言語の優先度 */
  aiLanguage: "auto" | "ja" | "en";
  /** 実行スタイル（どれくらい慎重／積極的に動くか） */
  aiExecutionStyle: "normal" | "careful" | "bold";
  /** 質問スタイル（どれくらい積極的に確認質問するか） */
  aiQuestioningStyle: "auto" | "proactive" | "minimal";
  /** 説明スタイル（どの程度ステップバイステップで説明するか） */
  aiExplainStyle: "auto" | "high_level" | "step_by_step";
  /** モデルのハイブリッドルーティングを有効にするか（Auto 時） */
  aiHybridRouting: boolean;
  showImagePreviewPane: boolean;
  /** コマンド送信後の実行経路表示（[RT] 実行済み 等）を表示する */
  showCommandTrace: boolean;
  /** GPU 状態ペイン（nvidia-smi 逐次表示）を表示する */
  showGpuPanel: boolean;
  /** AI チャットペイン（Preview/GPU と同じ欄）を表示する */
  showAiChatPanel: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  uiDensity: "comfortable",
  editorTheme: "vs-dark",
  editorKeymap: "vscode",
  editorFontSize: 13,
  editorFontFamily: "Consolas, 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  editorWordWrap: "off",
  editorLineNumbers: true,
  editorMinimap: false,
  terminalFontSize: 13,
  terminalFontFamily: "Consolas, 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  terminalMaxLines: 5000,
  terminalPollMs: 1000,
  aiFontSize: 12,
  aiPersona: "",
  aiTone: "neutral",
  aiResponseLength: "normal",
  aiLanguage: "auto",
  aiExecutionStyle: "normal",
  aiQuestioningStyle: "auto",
  aiExplainStyle: "auto",
  aiHybridRouting: true,
  showImagePreviewPane: true,
  showCommandTrace: false,
  showGpuPanel: false,
  showAiChatPanel: false
};

interface PreferencesContextValue {
  preferences: Preferences;
  updatePreferences: (patch: Partial<Preferences>) => void;
  resetPreferences: () => void;
}

const STORAGE_KEY = "syncterm-web-preferences-v1";
const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined);

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sanitizePreferences(raw: Partial<Preferences>): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...raw,
    aiPersona: typeof raw.aiPersona === "string" ? raw.aiPersona : DEFAULT_PREFERENCES.aiPersona,
    aiTone:
      raw.aiTone === "friendly" || raw.aiTone === "strict" || raw.aiTone === "neutral"
        ? raw.aiTone
        : DEFAULT_PREFERENCES.aiTone,
    aiResponseLength:
      raw.aiResponseLength === "short" ||
      raw.aiResponseLength === "detailed" ||
      raw.aiResponseLength === "normal"
        ? raw.aiResponseLength
        : DEFAULT_PREFERENCES.aiResponseLength,
    aiLanguage:
      raw.aiLanguage === "ja" || raw.aiLanguage === "en" || raw.aiLanguage === "auto"
        ? raw.aiLanguage
        : DEFAULT_PREFERENCES.aiLanguage,
    aiExecutionStyle:
      raw.aiExecutionStyle === "normal" || raw.aiExecutionStyle === "careful" || raw.aiExecutionStyle === "bold"
        ? raw.aiExecutionStyle
        : DEFAULT_PREFERENCES.aiExecutionStyle,
    aiQuestioningStyle:
      raw.aiQuestioningStyle === "auto" ||
      raw.aiQuestioningStyle === "proactive" ||
      raw.aiQuestioningStyle === "minimal"
        ? raw.aiQuestioningStyle
        : DEFAULT_PREFERENCES.aiQuestioningStyle,
    aiExplainStyle:
      raw.aiExplainStyle === "auto" ||
      raw.aiExplainStyle === "high_level" ||
      raw.aiExplainStyle === "step_by_step"
        ? raw.aiExplainStyle
        : DEFAULT_PREFERENCES.aiExplainStyle,
    aiHybridRouting: typeof raw.aiHybridRouting === "boolean" ? raw.aiHybridRouting : DEFAULT_PREFERENCES.aiHybridRouting,
    editorFontSize: clamp(Number(raw.editorFontSize ?? DEFAULT_PREFERENCES.editorFontSize), 10, 24),
    terminalFontSize: clamp(Number(raw.terminalFontSize ?? DEFAULT_PREFERENCES.terminalFontSize), 10, 24),
    aiFontSize: clamp(Number(raw.aiFontSize ?? DEFAULT_PREFERENCES.aiFontSize), 10, 24),
    terminalMaxLines: clamp(Number(raw.terminalMaxLines ?? DEFAULT_PREFERENCES.terminalMaxLines), 500, 30000),
    terminalPollMs: clamp(Number(raw.terminalPollMs ?? DEFAULT_PREFERENCES.terminalPollMs), 200, 5000)
  };
}

export const PreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) return DEFAULT_PREFERENCES;
      const parsed = JSON.parse(text) as Partial<Preferences>;
      return sanitizePreferences(parsed);
    } catch {
      return DEFAULT_PREFERENCES;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.dataset.density = preferences.uiDensity;
    root.style.setProperty("--editor-font-family", preferences.editorFontFamily);
    root.style.setProperty("--editor-font-size", `${preferences.editorFontSize}px`);
    root.style.setProperty("--terminal-font-family", preferences.terminalFontFamily);
    root.style.setProperty("--terminal-font-size", `${preferences.terminalFontSize}px`);
    root.style.setProperty("--ai-font-size", `${preferences.aiFontSize}px`);
  }, [preferences]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences: (patch) =>
        setPreferences((prev) => sanitizePreferences({ ...prev, ...patch })),
      resetPreferences: () => setPreferences(DEFAULT_PREFERENCES)
    }),
    [preferences]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
};

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}

