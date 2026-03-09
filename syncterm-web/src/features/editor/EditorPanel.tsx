import React, { useEffect, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorType, IDisposable } from "monaco-editor";
import { useSession } from "../session/SessionContext";
import { api } from "../../lib/api";
import { getStoredAiModel } from "./AiChatPanel";
import { isImagePath } from "../../lib/fileType";
import { detectEditorLanguage, INLINE_COMPLETION_LANGUAGES } from "../../lib/editorLanguage";
import { usePreferences } from "../preferences/PreferencesContext";
import { useActiveEditor } from "./ActiveEditorContext";

interface OpenFile {
  path: string;
  content: string;
  isDirty: boolean;
  isChunked?: boolean;
  nextOffset?: number;
  hasMore?: boolean;
  totalSize?: number;
}

interface EditorPanelProps {
  filePath: string | null;
  openFilePaths: string[];
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}

function configureMonacoThemes(monaco: Monaco) {
  monaco.editor.defineTheme("spyder-dark-bright", {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: "F5F7FA" },
      { token: "comment", foreground: "9AA7B0" },
      { token: "keyword", foreground: "C577F1" },
      { token: "keyword.operator.logical", foreground: "C577F1" },
      { token: "keyword.operator.word", foreground: "C577F1" },
      { token: "operator", foreground: "FFFFFF" },
      { token: "delimiter", foreground: "FFFFFF" },
      { token: "punctuation", foreground: "FFFFFF" },
      { token: "string", foreground: "B2F187", fontStyle: "italic" },
      { token: "string.escape", foreground: "B2F187" },
      { token: "string.interpolated", foreground: "B2F187" },
      { token: "number", foreground: "FFDD1A" },
      { token: "regexp", foreground: "B2F187" },
      { token: "type", foreground: "5CE1FA" },
      { token: "class", foreground: "5CE1FA", fontStyle: "bold" },
      { token: "function", foreground: "5CE1FA", fontStyle: "bold" },
      { token: "variable", foreground: "F5F7FA" },
      { token: "variable.readonly", foreground: "F5F7FA" },
      { token: "parameter", foreground: "F5F7FA" },
      { token: "property", foreground: "F5F7FA" },
      { token: "constant", foreground: "E1A66E" },
      { token: "predefined", foreground: "E1A66E" },
      { token: "decorator", foreground: "F57380", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#19232D",
      "editor.foreground": "#F5F7FA",
      "editorLineNumber.foreground": "#9AA7B0",
      "editorLineNumber.activeForeground": "#F5F7FA",
      "editor.lineHighlightBackground": "#22303D",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2F587A",
      "editor.selectionForeground": "#FFFFFF",
      "editor.inactiveSelectionBackground": "#2F587A99",
      "editorCursor.foreground": "#FFFFFF",
      "editorBracketMatch.background": "#2F587A55",
      "editorBracketMatch.border": "#41515E"
    }
  });
}

function trimEchoedPrefix(prefix: string, completion: string): string {
  if (!completion) return "";
  let text = completion;
  const tail = (prefix || "").slice(-4000);
  const max = Math.min(tail.length, text.length);
  for (let k = max; k > 0; k -= 1) {
    if (tail.endsWith(text.slice(0, k))) {
      text = text.slice(k);
      break;
    }
  }
  return text;
}

function sanitizeInlineCompletion(raw: string, prefix: string): string {
  let text = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const lines = text.split("\n");
  const firstLineContent = lines[0] ?? "";
  if (firstLineContent.includes("```")) return "";
  const firstLineTrimmed = trimEchoedPrefix(prefix, firstLineContent);
  const restLines = lines.slice(1);
  text = restLines.length > 0 ? [firstLineTrimmed, ...restLines].join("\n") : firstLineTrimmed;
  if (!text.trim()) return "";
  const maxLen = 800;
  const maxLines = 25;
  const outLines = text.split("\n");
  if (outLines.length > maxLines) {
    text = outLines.slice(0, maxLines).join("\n");
  }
  if (text.length > maxLen) {
    const truncated = text.slice(0, maxLen);
    const lastNewline = truncated.lastIndexOf("\n");
    text = lastNewline > 0 ? truncated.slice(0, lastNewline + 1) : truncated;
  }
  const lower = text.trimStart().toLowerCase();
  if (text.length > 15 && (lower.startsWith("import ") || lower.startsWith("from "))) {
    return "";
  }
  return text;
}

export const EditorPanel: React.FC<EditorPanelProps> = ({
  filePath,
  openFilePaths,
  onSelectFile,
  onCloseFile
}) => {
  const { currentWatcher, currentSession } = useSession();
  const { preferences } = usePreferences();
  const [filesByPath, setFilesByPath] = useState<Record<string, OpenFile>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveBadge, setSaveBadge] = useState<"saved" | "error" | null>(null);
  const [editorInstance, setEditorInstance] = useState<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  const inlineReqSeqRef = useRef(0);
  const { setActiveEditorState, registerApplyToSelection, registerAppendAtCursor } = useActiveEditor();
  const isImageFile = !!filePath && isImagePath(filePath);
  const file = filePath ? filesByPath[filePath] ?? null : null;
  const filesByPathRef = useRef<Record<string, OpenFile>>({});
  const filePathRef = useRef<string | null>(null);
  const watcherIdRef = useRef<string | undefined>(undefined);
  const sessionNameRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    filesByPathRef.current = filesByPath;
    filePathRef.current = filePath;
    watcherIdRef.current = currentWatcher?.id;
    sessionNameRef.current = currentSession?.name;
  }, [filesByPath, filePath, currentWatcher?.id, currentSession?.name]);

  // watcher/session が変わったらタブキャッシュをクリア
  useEffect(() => {
    setFilesByPath({});
    setError(null);
    setLoadingPath(null);
  }, [currentWatcher?.id, currentSession?.name]);

  // File ツリーから渡ってきたパスが変わったら内容を取得
  useEffect(() => {
    const load = async () => {
      if (!currentWatcher || !currentSession || !filePath) {
        setError(null);
        setLoadingPath(null);
        return;
      }
      if (isImagePath(filePath)) {
        setError(null);
        setLoadingPath(null);
        return;
      }
      if (file) {
        setError(null);
        setLoadingPath(null);
        return;
      }
      try {
        setError(null);
        setLoadingPath(filePath);
        const content = await api.fetchFileContent(currentWatcher.id, currentSession.name, filePath);
        setFilesByPath((prev) => ({
          ...prev,
          [filePath]: { path: filePath, content, isDirty: false, isChunked: false }
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to open file";
        // HTTP 413: switch to chunk mode instead of failing hard.
        if (msg.includes("HTTP 413")) {
          try {
            const first = await api.fetchFileChunk(
              currentWatcher.id,
              currentSession.name,
              filePath,
              0
            );
            setFilesByPath((prev) => ({
              ...prev,
              [filePath]: {
                path: filePath,
                content: first.content,
                isDirty: false,
                isChunked: true,
                nextOffset: first.nextOffset,
                hasMore: first.hasMore,
                totalSize: first.totalSize
              }
            }));
            setError(null);
            return;
          } catch (chunkErr) {
            setError(chunkErr instanceof Error ? chunkErr.message : "Failed to load chunk");
            return;
          }
        }
        setError(msg);
      } finally {
        setLoadingPath((prev) => (prev === filePath ? null : prev));
      }
    };
    void load();
  }, [currentWatcher, currentSession, filePath, file]);

  const handleChange = (value: string | undefined) => {
    if (!filePath) return;
    const nextContent = value ?? "";
    setFilesByPath((prev) => {
      const current = prev[filePath];
      if (!current) return prev;
      return {
        ...prev,
        [filePath]: { ...current, content: nextContent, isDirty: true }
      };
    });
  };

  const handleSave = async () => {
    const activePath = filePathRef.current;
    const watcherId = watcherIdRef.current;
    const sessionName = sessionNameRef.current;
    if (!activePath || !watcherId || !sessionName) return;
    const activeFile = filesByPathRef.current[activePath];
    if (!activeFile || activeFile.isChunked) return;
    const editorValue = editorInstance?.getValue();
    const contentToSave = typeof editorValue === "string" ? editorValue : activeFile.content;

    setIsSaving(true);
    setSaveBadge(null);
    try {
      await api.saveFileContent(watcherId, sessionName, activeFile.path, contentToSave);
      setFilesByPath((prev) => ({
        ...prev,
        [activeFile.path]: { ...activeFile, content: contentToSave, isDirty: false }
      }));
      setSaveBadge("saved");
      setTimeout(() => setSaveBadge(null), 1200);
    } catch {
      setSaveBadge("error");
      setTimeout(() => setSaveBadge(null), 1800);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoadMore = async () => {
    if (!file || !file.isChunked || !file.hasMore || !currentWatcher || !currentSession) return;
    try {
      const chunk = await api.fetchFileChunk(
        currentWatcher.id,
        currentSession.name,
        file.path,
        file.nextOffset ?? 0
      );
      setFilesByPath((prev) => ({
        ...prev,
        [file.path]: {
          ...file,
          content: file.content + chunk.content,
          nextOffset: chunk.nextOffset,
          hasMore: chunk.hasMore,
          totalSize: chunk.totalSize
        }
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    }
  };

  const handleComment = async () => {
    if (!editorInstance) return;
    await editorInstance.getAction("editor.action.commentLine")?.run();
  };

  useEffect(() => {
    if (!editorInstance || !file) {
      setActiveEditorState({ path: null, content: "", selectedText: "" });
      return;
    }
    const updateContent = () => {
      setActiveEditorState({ path: file.path, content: editorInstance.getValue() });
    };
    updateContent();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const d = editorInstance.onDidChangeModelContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(updateContent, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      d.dispose();
    };
  }, [editorInstance, file?.path, setActiveEditorState]);

  useEffect(() => {
    if (!editorInstance) return;
    const updateSelection = () => {
      const sel = editorInstance.getSelection();
      const selectedText =
        sel && !sel.isEmpty() ? editorInstance.getModel()?.getValueInRange(sel) ?? "" : "";
      setActiveEditorState({ selectedText });
    };
    updateSelection();
    const d = editorInstance.onDidChangeCursorSelection(updateSelection);
    return () => d.dispose();
  }, [editorInstance, setActiveEditorState]);

  useEffect(() => {
    if (!editorInstance || !monacoInstance) {
      registerApplyToSelection(null);
      registerAppendAtCursor(null);
      return;
    }
    const model = editorInstance.getModel();
    registerApplyToSelection((text: string) => {
      const sel = editorInstance.getSelection();
      if (!sel || sel.isEmpty()) return;
      editorInstance.executeEdits("ai-assist", [{ range: sel, text, forceMoveMarkers: true }]);
      const m = editorInstance.getModel();
      if (m && filePathRef.current) {
        setFilesByPath((prev) => {
          const cur = prev[filePathRef.current!];
          if (!cur) return prev;
          return { ...prev, [filePathRef.current!]: { ...cur, content: m.getValue(), isDirty: true } };
        });
      }
    });
    registerAppendAtCursor((text: string) => {
      const m = editorInstance.getModel();
      if (!m) return;
      const lastLine = m.getLineCount();
      const lastCol = m.getLineMaxColumn(lastLine);
      const range = new monacoInstance.Range(lastLine, lastCol, lastLine, lastCol);
      editorInstance.executeEdits("ai-assist", [
        { range, text: `\n\n${text}\n`, forceMoveMarkers: true }
      ]);
      if (filePathRef.current) {
        setFilesByPath((prev) => {
          const cur = prev[filePathRef.current!];
          if (!cur) return prev;
          return { ...prev, [filePathRef.current!]: { ...cur, content: m.getValue(), isDirty: true } };
        });
      }
    });
    return () => {
      registerApplyToSelection(null);
      registerAppendAtCursor(null);
    };
  }, [editorInstance, monacoInstance, registerApplyToSelection, registerAppendAtCursor]);

  useEffect(() => {
    if (!editorInstance || !monacoInstance) return;

    const disposables: IDisposable[] = [];
    const { KeyMod, KeyCode } = monacoInstance;

    const saveKb = KeyMod.CtrlCmd | KeyCode.KeyS;
    const commentKb =
      preferences.editorKeymap === "spyder" ? KeyMod.CtrlCmd | KeyCode.Digit1 : KeyMod.CtrlCmd | KeyCode.Slash;
    disposables.push(
      editorInstance.addAction({
        id: "syncterm.editor.save",
        label: "Save File",
        precondition: "editorTextFocus && !findWidgetVisible && !findInputFocussed",
        keybindings: [saveKb],
        run: async () => {
          await handleSave();
        }
      })
    );

    // Accept inline suggestion with Tab when ghost text is visible.
    disposables.push(
      editorInstance.addAction({
        id: "syncterm.editor.acceptInlineWithTab",
        label: "Accept Inline Suggestion",
        keybindings: [KeyCode.Tab],
        precondition: "editorTextFocus && inlineSuggestionVisible",
        run: async () => {
          await editorInstance.getAction("editor.action.inlineSuggest.commit")?.run();
        }
      })
    );
    disposables.push(
      editorInstance.addAction({
        id: "syncterm.editor.comment",
        label: "Toggle Line Comment",
        precondition: "editorTextFocus && !findWidgetVisible && !findInputFocussed",
        keybindings: [commentKb],
        run: async () => {
          await handleComment();
        }
      })
    );

    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [editorInstance, monacoInstance, preferences.editorKeymap, file?.path, currentWatcher?.id, currentSession?.name]);

  // AI inline completion provider (ghost text). 複数言語に登録して言語不一致で呼ばれないことを防ぐ。
  useEffect(() => {
    if (!editorInstance || !monacoInstance || !file || !currentWatcher || !currentSession) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const language = detectEditorLanguage(file.path);
    let disposed = false;
    const provider = {
      provideInlineCompletions: async (
        m: MonacoEditorType.ITextModel,
        position: MonacoEditorType.Position,
        _context: unknown,
        _token: unknown
      ) => {
        if (disposed || file.isChunked) return { items: [] };
        const prefix = m.getValueInRange(
          new monacoInstance.Range(1, 1, position.lineNumber, position.column)
        );
        const suffix = m.getValueInRange(
          new monacoInstance.Range(
            position.lineNumber,
            position.column,
            m.getLineCount(),
            m.getLineMaxColumn(m.getLineCount())
          )
        );
        if (prefix.trim().length < 2) return { items: [] };
        const reqId = ++inlineReqSeqRef.current;
        const log = import.meta.env?.DEV ? console.log : () => {};
        try {
          log("[inline] requesting", { path: file.path, prefixLen: prefix.length });
          const model = getStoredAiModel(currentWatcher.id, currentSession.name) ?? undefined;
          const out = await api.getAiInlineCompletion(currentWatcher.id, currentSession.name, {
            path: file.path,
            prefix,
            suffix,
            language,
            model
          });
          if (disposed || reqId !== inlineReqSeqRef.current) return { items: [] };
          const raw = (out.completion || "").trim();
          const text = sanitizeInlineCompletion(raw, prefix);
          if (!text) {
            if (raw && import.meta.env?.DEV) console.warn("[inline] sanitize dropped", { raw: raw.slice(0, 80) });
            return { items: [] };
          }
          log("[inline] got suggestion", text.slice(0, 40));
          return {
            items: [
              {
                insertText: text,
                range: new monacoInstance.Range(
                  position.lineNumber,
                  position.column,
                  position.lineNumber,
                  position.column
                )
              }
            ]
          };
        } catch (e) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[inline] AI inline completion failed", e);
          }
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {},
      disposeInlineCompletions: () => {}
    };
    const disposables = INLINE_COMPLETION_LANGUAGES.map((lang) =>
      monacoInstance.languages.registerInlineCompletionsProvider(lang, provider)
    );
    return () => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    };
  }, [editorInstance, monacoInstance, file?.path, file?.isChunked, currentWatcher?.id, currentSession?.name]);

  // Trigger inline suggestions after typing so ghost text appears.
  useEffect(() => {
    if (!editorInstance || !file || file.isChunked) return;
    const model = editorInstance.getModel();
    if (!model) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      const action = editorInstance.getAction("editor.action.inlineSuggest.trigger");
      if (action) void action.run();
    };
    const disposable = editorInstance.onDidChangeModelContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, 350);
    });

    return () => {
      if (timer) clearTimeout(timer);
      disposable.dispose();
    };
  }, [editorInstance, file?.path, file?.isChunked]);

  // Prevent tooltip text from blocking clicks on find-widget close button.
  useEffect(() => {
    if (!editorInstance) return;
    const dom = editorInstance.getDomNode();
    if (!dom) return;

    const stripCloseTooltip = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      const closeBtn = target.closest(".find-widget > .button.codicon-widget-close");
      if (closeBtn instanceof HTMLElement) {
        closeBtn.setAttribute("title", "");
      }
    };

    const onMouseOver = (e: MouseEvent) => stripCloseTooltip(e.target);
    dom.addEventListener("mouseover", onMouseOver, true);

    // Initial pass for already-rendered find widget.
    const existing = dom.querySelector(".find-widget > .button.codicon-widget-close");
    if (existing instanceof HTMLElement) {
      existing.setAttribute("title", "");
    }

    return () => {
      dom.removeEventListener("mouseover", onMouseOver, true);
    };
  }, [editorInstance]);

  const monacoOptions = {
    readOnly: !!file?.isChunked,
    minimap: { enabled: preferences.editorMinimap },
    fontSize: preferences.editorFontSize,
    lineHeight: Math.round(preferences.editorFontSize * 1.57),
    fontFamily: preferences.editorFontFamily,
    lineNumbers: preferences.editorLineNumbers ? "on" : "off",
    smoothScrolling: true,
    tabCompletion: "on",
    inlineSuggest: { enabled: true },
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: true,
    wordBasedSuggestions: "currentDocument",
    wordWrap: preferences.editorWordWrap,
    renderLineHighlight: "line",
    automaticLayout: true,
    scrollBeyondLastLine: false,
    bracketPairColorization: { enabled: false },
    guides: { bracketPairs: false }
  } as any;

  if (preferences.editorTheme === "spyder") {
    monacoOptions["semanticHighlighting.enabled"] = true;
  }

  return (
    <div className="pane pane-right">
      <div className="pane-header">
        <span className="pane-title">
          Editor {file ? ` — ${file.path}${file.isDirty ? " *" : ""}` : ""}
        </span>
        <div className="pane-header-actions">
          {saveBadge && (
            <span className={`save-badge ${saveBadge === "saved" ? "ok" : "ng"}`}>
              {saveBadge === "saved" ? "Saved" : "Save failed"}
            </span>
          )}
          <button
            className="primary-button"
            disabled={!file || !!file.isChunked || isImageFile || isSaving}
            onClick={handleSave}
            title={file?.isChunked ? "Chunkモードでは保存できません" : isImageFile ? "画像は右側プレビューペインで表示されます" : "保存"}
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
          {file?.isChunked && (
            <button
              className="primary-button"
              disabled={!file.hasMore}
              onClick={handleLoadMore}
              title="次のチャンクを読み込む"
            >
              Load More
            </button>
          )}
        </div>
      </div>
      <div className="pane-body editor-body">
        {openFilePaths.length > 0 && (
          <div className="editor-tabs">
            {openFilePaths.map((path) => {
              const isActive = path === filePath;
              const name = path.split("/").filter(Boolean).pop() ?? path;
              return (
                <button
                  key={path}
                  type="button"
                  className={`editor-tab${isActive ? " active" : ""}`}
                  onClick={() => onSelectFile(path)}
                  title={path}
                >
                  <span className="editor-tab-label">{name}</span>
                  <span
                    className="editor-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseFile(path);
                    }}
                    aria-label={`Close ${name}`}
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {file ? (
          <>
            {file.isChunked && (
              <div className="pane-empty" style={{ paddingTop: 0 }}>
                大容量ファイルのため分割読み込みモードで表示中
                {typeof file.totalSize === "number" ? ` (${file.totalSize} bytes)` : ""}。
                {file.hasMore ? " [Load More] で続きを取得できます。" : " すべて読み込み済みです。"}
              </div>
            )}
            <MonacoEditor
              className="editor-monaco"
              language={detectEditorLanguage(file.path)}
              beforeMount={configureMonacoThemes}
              theme={preferences.editorTheme === "spyder" ? "spyder-dark-bright" : preferences.editorTheme}
              value={file.content}
              onChange={(value) => handleChange(value)}
              onMount={(editor, monaco) => {
                setEditorInstance(editor);
                setMonacoInstance(monaco);
              }}
              options={monacoOptions}
            />
          </>
        ) : loadingPath && loadingPath === filePath ? (
          <div className="pane-empty">読み込み中...</div>
        ) : error ? (
          <div className="pane-empty">
            ファイルを開けませんでした。
            <br />
            {error}
          </div>
        ) : isImageFile ? (
          <div className="pane-empty">画像は右側の Image Preview ペインに表示されます。</div>
        ) : (
          <div className="pane-empty">
            まだファイルが開かれていません。
            <br />
            File ツリーからファイルを選択する実装を今後追加します。
          </div>
        )}
      </div>
    </div>
  );
};

