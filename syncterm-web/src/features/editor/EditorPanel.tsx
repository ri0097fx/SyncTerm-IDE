import React, { useEffect, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorType, IDisposable } from "monaco-editor";
import { useSession } from "../session/SessionContext";
import { api } from "../../lib/api";
import { isImagePath } from "../../lib/fileType";
import { detectEditorLanguage } from "../../lib/editorLanguage";
import { usePreferences } from "../preferences/PreferencesContext";

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
  let text = (raw || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return "";
  if (text.includes("```")) return "";
  text = text.split("\n", 1)[0].replace(/\s+$/, "");
  text = trimEchoedPrefix(prefix, text);
  if (!text.trim()) return "";
  if (text.length > 160) text = text.slice(0, 160).replace(/\s+$/, "");
  const lower = text.toLowerCase();
  if (lower.startsWith("import ") || lower.startsWith("from ")) {
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
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiAction, setAiAction] = useState("refactor");
  const [aiResult, setAiResult] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const inlineReqSeqRef = useRef(0);
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

  const handleAiAssist = async () => {
    const activePath = filePathRef.current;
    const watcherId = watcherIdRef.current;
    const sessionName = sessionNameRef.current;
    if (!activePath || !watcherId || !sessionName || !editorInstance) return;
    const activeFile = filesByPathRef.current[activePath];
    if (!activeFile) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const selection = editorInstance.getSelection();
      const selectedText =
        selection && !selection.isEmpty() ? editorInstance.getModel()?.getValueInRange(selection) ?? "" : "";
      const res = await api.runAiAssist(watcherId, sessionName, {
        path: activePath,
        action: aiAction,
        prompt: aiPrompt.trim() || "Improve this code",
        selectedText,
        fileContent: editorInstance.getValue()
      });
      setAiResult(res.result || "");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI assist failed");
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiToSelection = () => {
    if (!editorInstance || !aiResult) return;
    const selection = editorInstance.getSelection();
    if (!selection || selection.isEmpty()) return;
    const model = editorInstance.getModel();
    if (!model) return;
    editorInstance.executeEdits("ai-assist", [{ range: selection, text: aiResult, forceMoveMarkers: true }]);
    const next = model.getValue();
    if (filePathRef.current) {
      setFilesByPath((prev) => {
        const cur = prev[filePathRef.current as string];
        if (!cur) return prev;
        return { ...prev, [filePathRef.current as string]: { ...cur, content: next, isDirty: true } };
      });
    }
  };

  const appendAiResult = () => {
    if (!editorInstance || !aiResult || !monacoInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    const range = new monacoInstance.Range(lastLine, lastCol, lastLine, lastCol);
    editorInstance.executeEdits("ai-assist", [
      { range, text: `\n\n${aiResult}\n`, forceMoveMarkers: true }
    ]);
    const next = model.getValue();
    if (filePathRef.current) {
      setFilesByPath((prev) => {
        const cur = prev[filePathRef.current as string];
        if (!cur) return prev;
        return { ...prev, [filePathRef.current as string]: { ...cur, content: next, isDirty: true } };
      });
    }
  };

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

  // AI inline completion provider (ghost text).
  useEffect(() => {
    if (!editorInstance || !monacoInstance || !file || !currentWatcher || !currentSession) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const language = detectEditorLanguage(file.path);
    let disposed = false;
    const providerDisposable = monacoInstance.languages.registerInlineCompletionsProvider(language, {
      provideInlineCompletions: async (m, position, _context, _token) => {
        if (disposed || file.isChunked) {
          return { items: [] };
        }
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
        // Avoid excessive requests for extremely short context.
        if (prefix.trim().length < 2) return { items: [] };
        const reqId = ++inlineReqSeqRef.current;
        try {
          const out = await api.getAiInlineCompletion(currentWatcher.id, currentSession.name, {
            path: file.path,
            prefix,
            suffix,
            language
          });
          if (disposed || reqId !== inlineReqSeqRef.current) return { items: [] };
          const text = sanitizeInlineCompletion(out.completion || "", prefix);
          if (!text) return { items: [] };
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
        } catch {
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {}
    });
    return () => {
      disposed = true;
      providerDisposable.dispose();
    };
  }, [editorInstance, monacoInstance, file?.path, file?.isChunked, currentWatcher?.id, currentSession?.name]);

  // Trigger inline suggestions shortly after typing so ghost text appears consistently.
  useEffect(() => {
    if (!editorInstance || !file || file.isChunked) return;
    const model = editorInstance.getModel();
    if (!model) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const disposable = editorInstance.onDidChangeModelContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void editorInstance.getAction("editor.action.inlineSuggest.trigger")?.run();
      }, 220);
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
            {preferences.showAiAssistPanel && (
              <div className="ai-assist-panel">
                <div className="ai-assist-row">
                  <select
                    className="session-select"
                    value={aiAction}
                    onChange={(e) => setAiAction(e.target.value)}
                  >
                    <option value="refactor">Refactor</option>
                    <option value="fix">Fix</option>
                    <option value="explain">Explain as code comments</option>
                    <option value="generate">Generate code</option>
                  </select>
                  <input
                    className="terminal-input"
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="AI instruction..."
                  />
                  <button className="primary-button" disabled={aiLoading} onClick={() => void handleAiAssist()}>
                    {aiLoading ? "Thinking..." : "AI Assist"}
                  </button>
                </div>
                {aiError && (
                  <div className="pane-empty" style={{ color: "#fca5a5", paddingTop: 6 }}>
                    {aiError}
                  </div>
                )}
                {aiResult && (
                  <div className="ai-assist-result">
                    <div className="ai-assist-actions">
                      <button
                        className="icon-button"
                        style={{ width: "auto", padding: "0 0.7rem" }}
                        onClick={applyAiToSelection}
                      >
                        Replace Selection
                      </button>
                      <button
                        className="icon-button"
                        style={{ width: "auto", padding: "0 0.7rem" }}
                        onClick={appendAiResult}
                      >
                        Append Result
                      </button>
                    </div>
                    <pre className="terminal-line">{aiResult}</pre>
                  </div>
                )}
              </div>
            )}
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

