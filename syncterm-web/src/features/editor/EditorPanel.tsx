import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { ExtensionPanelHost } from "../extensions/ExtensionPanelHost";

interface OpenFile {
  path: string;
  content: string;
  isDirty: boolean;
  isChunked?: boolean;
  nextOffset?: number;
  hasMore?: boolean;
  totalSize?: number;
}

interface DockedPanel {
  extensionId: string;
  id: string;
  title: string;
  model?: unknown;
}

interface EditorPanelProps {
  filePath: string | null;
  openFilePaths: string[];
  treeReopenTick?: number;
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  dockedPanels?: DockedPanel[];
  activeDockedPanelId?: string | null;
  onSelectDockedPanel?: (panelId: string | null) => void;
  onToggleDock?: (panelId: string) => void;
}

function normalizeSessionPathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getSetiIconClassForPath(path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const lower = name.toLowerCase();

  // フォーマットはファイルツリーと揃える（.sh はテキスト扱い）
  if (lower.endsWith(".py")) return "file-tree-icon-python";
  if (lower.endsWith(".sh")) return "file-tree-icon-text";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "file-tree-icon-markdown";

  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "file-tree-icon-typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) {
    return "file-tree-icon-javascript";
  }

  if (
    lower.endsWith(".json") ||
    lower.endsWith(".jsonc") ||
    lower.endsWith(".jsonl")
  ) {
    return "file-tree-icon-json";
  }

  if (lower.endsWith(".csv")) return "file-tree-icon-csv";

  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "file-tree-icon-text";

  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".svg")
  ) {
    return "file-tree-icon-image";
  }

  return "file-tree-icon-file";
}

function configureMonacoThemes(monaco: Monaco) {
  const sharedRules = [
      { token: "", foreground: "F5F7FA" },
      { token: "comment", foreground: "9AA7B0" },
      { token: "keyword", foreground: "C577F1" },
      { token: "keyword.operator.logical", foreground: "C577F1" },
      { token: "keyword.operator.word", foreground: "C577F1" },
      { token: "keyword.control", foreground: "C577F1" },
      { token: "operator", foreground: "FFFFFF" },
      { token: "delimiter", foreground: "FFFFFF" },
      { token: "brackets", foreground: "FFFFFF" },
      { token: "delimiter.bracket", foreground: "FFFFFF" },
      { token: "delimiter.parenthesis", foreground: "FFFFFF" },
      { token: "delimiter.square", foreground: "FFFFFF" },
      { token: "delimiter.curly", foreground: "FFFFFF" },
      { token: "delimiter.bracket.python", foreground: "FFFFFF" },
      { token: "delimiter.parenthesis.python", foreground: "FFFFFF" },
      { token: "delimiter.square.python", foreground: "FFFFFF" },
      { token: "delimiter.curly.python", foreground: "FFFFFF" },
      { token: "punctuation", foreground: "FFFFFF" },
      { token: "string", foreground: "B2F187", fontStyle: "italic" },
      { token: "string.escape", foreground: "B2F187" },
      { token: "string.interpolated", foreground: "B2F187" },
      { token: "number", foreground: "FFDD1A" },
      { token: "regexp", foreground: "B2F187" },
      { token: "type", foreground: "F5F7FA" },
      { token: "type.defaultLibrary", foreground: "F5F7FA" },
      { token: "class", foreground: "5CE1FA", fontStyle: "bold" },
      { token: "entity.name.type", foreground: "5CE1FA", fontStyle: "bold" },
      // def func(): の関数名は明るい水色
      { token: "function", foreground: "5CE1FA", fontStyle: "bold" },
      { token: "entity.name.function", foreground: "5CE1FA", fontStyle: "bold" },
      { token: "function.defaultLibrary", foreground: "E1A66E" },
      { token: "support.function", foreground: "E1A66E" },
      { token: "support.function.builtin", foreground: "E1A66E" },
      { token: "constant.language", foreground: "E1A66E" },
      { token: "constant.language.boolean", foreground: "E1A66E" },
      { token: "variable", foreground: "F5F7FA" },
      { token: "variable.readonly", foreground: "F5F7FA" },
      { token: "parameter", foreground: "F5F7FA" },
      { token: "property", foreground: "F5F7FA" },
      { token: "identifier", foreground: "F5F7FA" },
      { token: "constant", foreground: "E1A66E" },
      { token: "predefined", foreground: "E1A66E" },
      { token: "decorator", foreground: "F57380", fontStyle: "italic" },
      { token: "tag", foreground: "F57380", fontStyle: "italic" },
      { token: "variable.language.self", foreground: "F57380", fontStyle: "italic" },
      { token: "variable.language.self.python", foreground: "F57380", fontStyle: "italic" }
  ];
  const sharedColors = {
      "editorLineNumber.foreground": "#9AA7B0",
      "editorLineNumber.activeForeground": "#F5F7FA",
      "editor.lineHighlightBackground": "#22303D",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2F587A",
      "editor.selectionForeground": "#FFFFFF",
      "editor.inactiveSelectionBackground": "#2F587A99",
      "editorCursor.foreground": "#00E5FF",
      "editorCursor.background": "#00E5FF",
      "editor.selectionHighlightBackground": "#00000000",
      "editor.selectionHighlightBorder": "#00000000",
      "editor.wordHighlightBackground": "#00000000",
      "editor.wordHighlightStrongBackground": "#00000000",
      "editor.wordHighlightBorder": "#00000000",
      "editor.wordHighlightStrongBorder": "#00000000",
      // 括弧色が token ルールよりこちらで上書きされるケースがあるため、BracketHighlight 側も白で統一
      "editorBracketHighlight.foreground1": "#FFFFFF",
      "editorBracketHighlight.foreground2": "#FFFFFF",
      "editorBracketHighlight.foreground3": "#FFFFFF",
      "editorBracketHighlight.foreground4": "#FFFFFF",
      "editorBracketHighlight.foreground5": "#FFFFFF",
      "editorBracketHighlight.foreground6": "#FFFFFF",
      "editorBracketHighlight.unexpectedBracket.foreground": "#E47C7C",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#00000000"
  };

  monaco.editor.defineTheme("syncterm-dark-bright", {
    base: "vs-dark",
    inherit: true,
    rules: sharedRules,
    colors: {
      ...sharedColors,
      "editor.background": "#0F172A",
      "editor.foreground": "#F5F7FA",
    }
  });

  monaco.editor.defineTheme("syncterm-light-bright", {
    base: "vs",
    inherit: true,
    rules: sharedRules,
    colors: {
      ...sharedColors,
      "editor.background": "#FFFFFF",
      "editor.foreground": "#0F172A",
      "editorLineNumber.foreground": "#64748B",
      "editorLineNumber.activeForeground": "#0F172A",
      "editor.lineHighlightBackground": "#E2E8F0",
      "editor.selectionBackground": "#BFDBFE",
      "editor.inactiveSelectionBackground": "#DBEAFE",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#00000000"
    }
  });

  monaco.editor.defineTheme("spyder-dark-bright", {
    base: "vs-dark",
    inherit: true,
    rules: [
      ...sharedRules
    ],
    colors: {
      ...sharedColors,
      "editor.background": "#19232D",
      "editor.foreground": "#F5F7FA"
    }
  });

  const builtinNames = [
    "abs", "all", "any", "bool", "bytearray", "bytes", "callable", "chr", "dict", "dir",
    "enumerate", "filter", "float", "format", "frozenset", "getattr", "hasattr", "hash", "hex",
    "id", "input", "int", "isinstance", "issubclass", "iter", "len", "list", "map", "max", "memoryview",
    "min", "next", "object", "oct", "open", "ord", "pow", "print", "property", "range", "repr",
    "reversed", "round", "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
    "tuple", "type", "vars", "zip"
  ];
  const selfLikeNames = ["self", "cls"];
  const booleanLiterals = ["True", "False"];
  const pythonKeywords = [
    "None", "_", "and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def",
    "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"
  ];
  const pythonTokenizerRoot: any[] = [
    { include: "@whitespace" },
    { include: "@numbers" },
    { include: "@strings" },
    [/\b(async)(\s+)(def)(\s+)([a-zA-Z_]\w*)/, ["keyword", "white", "keyword", "white", "entity.name.function"]],
    [/\b(def)(\s+)([a-zA-Z_]\w*)/, ["keyword", "white", "entity.name.function"]],
    [/\b(class)(\s+)([a-zA-Z_]\w*)/, ["keyword", "white", "entity.name.type"]],
    [/[,:;]/, "delimiter"],
    [/[{}\[\]()]/, "@brackets"],
    [/@[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/, "decorator"],
    [
      /[a-zA-Z_]\w*/,
      {
        cases: {
          "_": "identifier",
          "@selfLikeNames": "variable.language.self",
          "@booleanLiterals": "constant.language.boolean",
          "@builtins": "support.function.builtin",
          "@keywords": "keyword",
          "@default": "identifier"
        }
      }
    ]
  ];
  monaco.languages.setMonarchTokensProvider("python", {
    defaultToken: "",
    tokenPostfix: ".python",
    keywords: pythonKeywords,
    builtins: builtinNames,
    selfLikeNames,
    booleanLiterals,
    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.bracket" },
      { open: "(", close: ")", token: "delimiter.parenthesis" }
    ],
    tokenizer: {
      root: pythonTokenizerRoot,
      whitespace: [
        [/\s+/, "white"],
        [/(^#.*$)/, "comment"],
        [/'''/, "string", "@endDocString"],
        [/"""/, "string", "@endDblDocString"]
      ],
      endDocString: [
        [/[^']+/, "string"],
        [/\\'/, "string"],
        [/'''/, "string", "@popall"],
        [/'/, "string"]
      ],
      endDblDocString: [
        [/[^"]+/, "string"],
        [/\\"/, "string"],
        [/"""/, "string", "@popall"],
        [/"/, "string"]
      ],
      numbers: [
        [/-?0x([abcdef]|[ABCDEF]|\d)+[lL]?/, "number.hex"],
        [/-?(\d*\.)?\d+([eE][+\-]?\d+)?[jJ]?[lL]?/, "number"]
      ],
      strings: [
        [/'$/, "string.escape", "@popall"],
        [/f'{1,3}/, "string.escape", "@fStringBody"],
        [/'/, "string.escape", "@stringBody"],
        [/"$/, "string.escape", "@popall"],
        [/f"{1,3}/, "string.escape", "@fDblStringBody"],
        [/"/, "string.escape", "@dblStringBody"]
      ],
      fStringBody: [
        [/[^\\'\{\}]+$/, "string", "@popall"],
        [/[^\\'\{\}]+/, "string"],
        // `{` の直後で `'` にぶつかって分割されると色が崩れるため、`{` だけで式状態へ入り `}` まで一括で string 扱い
        [/\{/, "string", "@fStringExpr"],
        [/\\./, "string"],
        [/'/, "string.escape", "@popall"],
        [/\\$/, "string"]
      ],
      stringBody: [
        [/[^\\']+$/, "string", "@popall"],
        [/[^\\']+/, "string"],
        [/\\./, "string"],
        [/'/, "string.escape", "@popall"],
        [/\\$/, "string"]
      ],
      fDblStringBody: [
        [/[^\\"\{\}]+$/, "string", "@popall"],
        [/[^\\"\{\}]+/, "string"],
        [/\{/, "string", "@fStringExpr"],
        [/\\./, "string"],
        [/"/, "string.escape", "@popall"],
        [/\\$/, "string"]
      ],
      dblStringBody: [
        [/[^\\"]+$/, "string", "@popall"],
        [/[^\\"]+/, "string"],
        [/\\./, "string"],
        [/"/, "string.escape", "@popall"],
        [/\\$/, "string"]
      ],
      // f-string 補間 `{ ... }` 内は全体を文字列色に統一（`log['key']` などの内側クォートも含む）
      fStringExpr: [
        [/[^}]+/, "string"],
        [/\}/, "string", "@pop"]
      ]
    }
  } as any);
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
  treeReopenTick = 0,
  onSelectFile,
  onCloseFile,
  dockedPanels = [],
  activeDockedPanelId = null,
  onSelectDockedPanel,
  onToggleDock
}) => {
  const { currentWatcher, currentSession } = useSession();
  const { preferences } = usePreferences();
  const [filesByPath, setFilesByPath] = useState<Record<string, OpenFile>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inlineAbortRef = React.useRef<AbortController | null>(null);
  const inlineLastReqAtRef = React.useRef<number>(0);
  const [saveBadge, setSaveBadge] = useState<"saved" | "error" | null>(null);
  const [editorInstance, setEditorInstance] = useState<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  const inlineReqSeqRef = useRef(0);
  const lastHandledTreeReopenByPathRef = useRef<Record<string, number>>({});
  const { setActiveEditorState, registerApplyToSelection, registerAppendAtCursor, registerFileAppliedFromAi } =
    useActiveEditor();
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

  useEffect(() => {
    registerFileAppliedFromAi((savedPath, newContent) => {
      const n = normalizeSessionPathKey(savedPath);
      setFilesByPath((prev) => {
        const key = Object.keys(prev).find((k) => normalizeSessionPathKey(k) === n);
        if (!key) return prev;
        const cur = prev[key];
        return {
          ...prev,
          [key]: {
            ...cur,
            content: newContent,
            isDirty: false,
            isChunked: false,
            hasMore: false,
            nextOffset: undefined,
            totalSize: undefined
          }
        };
      });
      const active = filePathRef.current;
      if (active && normalizeSessionPathKey(active) === n) {
        setActiveEditorState({ content: newContent });
      }
    });
    return () => registerFileAppliedFromAi(null);
  }, [registerFileAppliedFromAi, setActiveEditorState]);

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

  const reloadCurrentFileFromServer = useCallback(async (ifDirty: "skip" | "confirm") => {
    const w = watcherIdRef.current;
    const s = sessionNameRef.current;
    const path = filePathRef.current;
    if (!w || !s || !path || isImagePath(path)) return;
    const cur = filesByPathRef.current[path];
    if (!cur) return;
    if (cur.isDirty) {
      if (ifDirty === "skip") return;
      if (!window.confirm("未保存の変更を破棄してディスクから再読み込みしますか？")) return;
    }
    setError(null);
    setLoadingPath(path);
    try {
      if (cur.isChunked) {
        const first = await api.fetchFileChunk(w, s, path, 0);
        setFilesByPath((prev) => ({
          ...prev,
          [path]: {
            path,
            content: first.content,
            isDirty: false,
            isChunked: true,
            nextOffset: first.nextOffset,
            hasMore: first.hasMore,
            totalSize: first.totalSize
          }
        }));
      } else {
        try {
          const content = await api.fetchFileContent(w, s, path);
          setFilesByPath((prev) => ({
            ...prev,
            [path]: { path, content, isDirty: false, isChunked: false }
          }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : "";
          if (msg.includes("HTTP 413")) {
            const first = await api.fetchFileChunk(w, s, path, 0);
            setFilesByPath((prev) => ({
              ...prev,
              [path]: {
                path,
                content: first.content,
                isDirty: false,
                isChunked: true,
                nextOffset: first.nextOffset,
                hasMore: first.hasMore,
                totalSize: first.totalSize
              }
            }));
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "再読み込みに失敗しました");
    } finally {
      setLoadingPath((prev) => (prev === path ? null : prev));
    }
  }, []);

  useEffect(() => {
    if (!filePath) return;
    if (!treeReopenTick) {
      lastHandledTreeReopenByPathRef.current[filePath] = 0;
      return;
    }
    const prev = lastHandledTreeReopenByPathRef.current[filePath] ?? 0;
    if (treeReopenTick <= prev) return;
    lastHandledTreeReopenByPathRef.current[filePath] = treeReopenTick;
    void reloadCurrentFileFromServer("skip");
  }, [filePath, treeReopenTick, reloadCurrentFileFromServer]);

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
      // 保存を優先するため、inline completion の in-flight リクエストは中断
      try {
        inlineAbortRef.current?.abort();
      } catch {}
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
    if (!preferences.showAiChatPanel) return;
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
        if (isSaving) return { items: [] };

        // 貼り付け直後などの連打を抑制
        const now = Date.now();
        if (now - inlineLastReqAtRef.current < 800) return { items: [] };
        inlineLastReqAtRef.current = now;

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

        // 大きすぎるコンテキストは送らない（貼り付けで prefixLen が激増して詰まるのを防ぐ）
        const MAX_PREFIX = 2200;
        const MAX_SUFFIX = 800;
        const prefixTrimmed = prefix.length > MAX_PREFIX ? prefix.slice(-MAX_PREFIX) : prefix;
        const suffixTrimmed = suffix.length > MAX_SUFFIX ? suffix.slice(0, MAX_SUFFIX) : suffix;

        const reqId = ++inlineReqSeqRef.current;
        const log = import.meta.env?.DEV ? console.log : () => {};
        try {
          // in-flight をキャンセルして最新のみ残す
          try {
            inlineAbortRef.current?.abort();
          } catch {}
          const ctrl = new AbortController();
          inlineAbortRef.current = ctrl;

          log("[inline] requesting", { path: file.path, prefixLen: prefixTrimmed.length });
          const model = getStoredAiModel(currentWatcher.id, currentSession.name) ?? undefined;
          const out = await api.getAiInlineCompletion(currentWatcher.id, currentSession.name, {
            path: file.path,
            prefix: prefixTrimmed,
            suffix: suffixTrimmed,
            language,
            model
          }, { signal: ctrl.signal });
          if (disposed || reqId !== inlineReqSeqRef.current) return { items: [] };
          const raw = (out.completion || "").trim();
          const text = sanitizeInlineCompletion(raw, prefixTrimmed);
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
  }, [editorInstance, monacoInstance, file?.path, file?.isChunked, currentWatcher?.id, currentSession?.name, preferences.showAiChatPanel]);

  // Trigger inline suggestions after typing so ghost text appears.
  useEffect(() => {
    if (!preferences.showAiChatPanel) return;
    if (!editorInstance || !file || file.isChunked) return;
    if (isSaving) return;
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
  }, [editorInstance, file?.path, file?.isChunked, isSaving, preferences.showAiChatPanel]);

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
    inlineSuggest: { enabled: preferences.showAiChatPanel && !isSaving },
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: true,
    wordBasedSuggestions: "currentDocument",
    wordWrap: preferences.editorWordWrap,
    renderLineHighlight: "line",
    automaticLayout: true,
    scrollBeyondLastLine: false,
    selectionHighlight: false,
    occurrencesHighlight: "off",
    cursorStyle: "line",
    overtypeCursorStyle: "line",
    // line-thin では幅指定が効きにくいため line + 幅広で固定
    cursorWidth: 2,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: false }
  } as any;

  // semantic token が優先されると独自トークン色が反映されにくいため無効化
  monacoOptions["semanticHighlighting.enabled"] = false;

  useEffect(() => {
    if (!monacoInstance) return;
    configureMonacoThemes(monacoInstance);
    const nextTheme =
      preferences.editorTheme === "spyder"
        ? "spyder-dark-bright"
        : preferences.editorTheme === "vs-light"
        ? "syncterm-light-bright"
        : "syncterm-dark-bright";
    monacoInstance.editor.setTheme(nextTheme);
  }, [monacoInstance, preferences.editorTheme]);

  return (
    <div className="pane pane-right">
      <div className="pane-header">
        <span className="pane-title">
          {activeDockedPanelId
            ? (dockedPanels.find((p) => p.id === activeDockedPanelId)?.title ?? "Extension")
            : <>Editor {file ? ` — ${file.path}${file.isDirty ? " *" : ""}` : ""}</>}
        </span>
        {!activeDockedPanelId && (
          <div className="pane-header-actions">
            {saveBadge && (
              <span className={`save-badge ${saveBadge === "saved" ? "ok" : "ng"}`}>
                {saveBadge === "saved" ? "Saved" : "Save failed"}
              </span>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={!file || isImageFile || loadingPath === filePath}
              onClick={() => void reloadCurrentFileFromServer("confirm")}
              title="ディスク上の内容を再取得（未保存の変更がある場合は確認します）"
            >
              再読み込み
            </button>
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
        )}
      </div>
      <div className="pane-body editor-body">
        {(openFilePaths.length > 0 || dockedPanels.length > 0) && (
          <div className="editor-tabs">
            {openFilePaths.map((path) => {
              const isActive = path === filePath && !activeDockedPanelId;
              const name = path.split("/").filter(Boolean).pop() ?? path;
              const iconClass = getSetiIconClassForPath(path);
              return (
                <button
                  key={path}
                  type="button"
                  className={`editor-tab${isActive ? " active" : ""}`}
                  onClick={() => { onSelectDockedPanel?.(null); onSelectFile(path); }}
                  title={path}
                >
                  {!isImagePath(path) && (
                    <span className="editor-tab-icon">
                      <span className={`file-tree-icon ${iconClass}`} aria-hidden="true" />
                    </span>
                  )}
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
            {dockedPanels.length > 0 && openFilePaths.length > 0 && (
              <span className="editor-tab-separator" />
            )}
            {dockedPanels.map((panel) => {
              const isActive = activeDockedPanelId === panel.id;
              return (
                <button
                  key={`ext:${panel.id}`}
                  type="button"
                  className={`editor-tab editor-tab-ext${isActive ? " active" : ""}`}
                  onClick={() => onSelectDockedPanel?.(panel.id)}
                  title={`Extension: ${panel.title}`}
                >
                  <span className="editor-tab-icon editor-tab-ext-icon">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.2"/><path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
                  </span>
                  <span className="editor-tab-label">{panel.title}</span>
                  <span
                    className="editor-tab-close"
                    onClick={(e) => { e.stopPropagation(); onToggleDock?.(panel.id); }}
                    aria-label={`Undock ${panel.title}`}
                    title="Move back to Preview"
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {activeDockedPanelId ? (
          <div className="editor-ext-content">
            <ExtensionPanelHost panelId={activeDockedPanelId} isDockedToEditor onToggleDock={() => onToggleDock?.(activeDockedPanelId)} />
          </div>
        ) : file ? (
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
              theme={
                preferences.editorTheme === "spyder"
                  ? "spyder-dark-bright"
                  : preferences.editorTheme === "vs-light"
                  ? "syncterm-light-bright"
                  : "syncterm-dark-bright"
              }
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

