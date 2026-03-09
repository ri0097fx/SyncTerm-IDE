import React, { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import Prism from "prismjs";
// Prism 言語定義は依存関係のあるものを先にロードする必要がある
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";        // ★ jsx を先にロード
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";        // jsx に依存
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-markdown";
import "prismjs/themes/prism-tomorrow.css";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { useActiveEditor } from "./ActiveEditorContext";
import { api } from "../../lib/api";

type Message = { role: "user" | "assistant"; text: string };
type PendingCommand = { command: string };
const AUTO_MODEL = "__auto__";

const CHAT_STORAGE_KEY = "syncterm-ai-chat";

export function getChatStorageKey(watcherId: string, sessionName: string): string {
  return `${CHAT_STORAGE_KEY}-${watcherId}-${sessionName}`;
}

/** インライン補完などで使用するため、保存されている選択モデルを取得 */
export function getStoredAiModel(watcherId: string, sessionName: string): string | null {
  try {
    const raw = sessionStorage.getItem(getChatStorageKey(watcherId, sessionName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { selectedModel?: string };
    return parsed?.selectedModel ?? null;
  } catch {
    return null;
  }
}

export type ChatMode = "agent" | "plan" | "debug" | "ask";
export type ThinkingMode = "quick" | "balanced" | "deep";

type ChatState = {
  chatIds: string[];
  activeChatId: string;
  chats: Record<string, { name?: string; messages: Message[]; logs?: AgentLogEntry[] }>;
  selectedModel?: string;
  chatMode?: ChatMode;
  thinkingMode?: ThinkingMode;
};

type AgentLogEntry = {
  command: string;
  exitCode?: number;
  output?: string;
  error?: string;
};

function loadChatState(watcherId: string, sessionName: string): ChatState {
  try {
    const raw = sessionStorage.getItem(getChatStorageKey(watcherId, sessionName));
    if (!raw) return defaultChatState();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const id = crypto.randomUUID();
      return {
        chatIds: [id],
        activeChatId: id,
        chats: { [id]: { messages: parsed } },
        selectedModel: undefined
      };
    }
    if (parsed && typeof parsed.chatIds === "object" && Array.isArray(parsed.chatIds) && typeof parsed.chats === "object") {
      const ids = parsed.chatIds as string[];
      const activeChatId = (parsed.activeChatId && ids.includes(parsed.activeChatId)) ? parsed.activeChatId : ids[0];
      const rawChats = (parsed.chats ?? {}) as Record<string, { name?: string; messages?: unknown; logs?: AgentLogEntry[] }>;
      const chats: Record<string, { name?: string; messages: Message[]; logs?: AgentLogEntry[] }> = {};
      for (const id of ids) {
        const c = rawChats[id];
        chats[id] = {
          name: c?.name,
          messages: Array.isArray(c?.messages) ? (c.messages as Message[]) : [],
          logs: Array.isArray(c?.logs) ? c.logs : [],
        };
      }
      return {
        chatIds: ids,
        activeChatId: activeChatId ?? crypto.randomUUID(),
        chats,
        selectedModel: parsed.selectedModel ?? undefined,
        chatMode: parsed.chatMode ?? undefined,
        thinkingMode: parsed.thinkingMode ?? undefined
      };
    }
  } catch {
    /* ignore */
  }
  return defaultChatState();
}

function defaultChatState(): ChatState {
  const id = crypto.randomUUID();
  return {
    chatIds: [id],
    activeChatId: id,
    chats: { [id]: { messages: [] } },
    selectedModel: undefined,
    chatMode: "ask",
    thinkingMode: "balanced"
  };
}

function saveChatState(watcherId: string, sessionName: string, state: ChatState) {
  try {
    sessionStorage.setItem(getChatStorageKey(watcherId, sessionName), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** メッセージ本文から最初の Markdown コードブロックの内容を抽出 */
type MsgSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string | null; code: string };

function normalizePrismLanguage(language: string | null): string {
  if (!language) return "plaintext";
  const l = language.toLowerCase();
  if (l === "js" || l === "jsx") return "javascript";
  if (l === "ts" || l === "tsx") return "tsx";
  if (l === "py" || l === "python") return "python";
  if (l === "sh" || l === "bash" || l === "shell") return "bash";
  if (l === "json") return "json";
  if (l === "md" || l === "markdown") return "markdown";
  return l;
}

function pickAutoModel(
  aiModels: { installed: string[]; suggested: string[] },
  chatMode: ChatMode,
  thinkingMode: ThinkingMode
): string | undefined {
  const installed = new Set(aiModels.installed);

  // veryBig は 70B 級以上など、かなり重いモデル
  const veryBigModels = [
    "llama3:70b",
    "qwen2.5:72b-instruct-q3_K_M",
    "deepseek-coder-v2:236b"
  ];
  // big は実用的な大型モデル（32B〜33B や large 系）
  const bigModels = [
    "qwen2.5-coder:32b",
    "deepseek-coder:33b",
    "deepseek-coder-v2:16b",
    "mistral-large"
  ];
  const midModels = [
    "deepseek-coder-v2:16b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:7b",
    "llama3:8b",
    "mistral",
    "deepseek-coder:6.7b"
  ];
  const smallModels = [
    "qwen2.5-coder:3b",
    "qwen2.5-coder:1.5b",
    "llama3.2",
    "deepseek-coder:1.3b"
  ];

  // Auto では「ダウンロード済み（installed）」の中からのみ選ぶ
  const has = (name: string) => installed.has(name);
  const pickFrom = (list: string[]) => list.find(has);

  // まだ何もインストールされていない場合は undefined（→ バックエンドのデフォルトにフォールバック）
  if (aiModels.installed.length === 0) return undefined;

  if (thinkingMode === "quick" && chatMode !== "agent") {
    // Quick では中〜小さめを優先し、veryBig は最後の手段にする
    return (
      pickFrom(midModels) ||
      pickFrom(smallModels) ||
      pickFrom(bigModels) ||
      pickFrom(veryBigModels) ||
      aiModels.installed[0]
    );
  }
  // deep / agent などは大きめ優先
  return (
    pickFrom(bigModels) ||
    pickFrom(midModels) ||
    pickFrom(smallModels) ||
    pickFrom(veryBigModels) ||
    aiModels.installed[0]
  );
}

function splitMarkdownCodeFences(text: string): MsgSegment[] {
  const re = /```([\w-]+)?\n([\s\S]*?)```/g;
  const out: MsgSegment[] = [];
  let last = 0;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const start = m.index;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "code", language: m[1] ?? null, code: (m[2] ?? "").trim() });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length ? out : [{ kind: "text", text }];
}

export const AiChatPanel: React.FC = () => {
  const { currentWatcher, currentSession } = useSession();
  const { preferences, updatePreferences } = usePreferences();
  const { activeEditor, applyToSelection, appendAtCursor } = useActiveEditor();
  const [tab, setTab] = useState<"chat" | "assist" | "settings">("chat");
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [chats, setChats] = useState<Record<string, { name?: string; messages: Message[] }>>({});
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode>("ask");
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("balanced");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [aiAction, setAiAction] = useState("refactor");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<{ installed: string[]; suggested: string[] }>({ installed: [], suggested: [] });
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [ensuringModel, setEnsuringModel] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ model: string; status: string; percent?: number } | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [chatView, setChatView] = useState<"messages" | "logs">("messages");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const chatsRef = useRef(chats);
  const activeChatIdRef = useRef(activeChatId);
  const aiAbortRef = useRef<AbortController | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const buildPersonaInstructions = () => {
    const parts: string[] = [];
    const base = preferences.aiPersona?.trim();
    if (base) parts.push(base);
    if (preferences.aiTone === "friendly") {
      parts.push("Use a friendly, encouraging tone.");
    } else if (preferences.aiTone === "strict") {
      parts.push("Use a concise, direct tone and focus strictly on correctness.");
    }
    if (preferences.aiResponseLength === "short") {
      parts.push("Keep answers short and to the point.");
    } else if (preferences.aiResponseLength === "detailed") {
      parts.push("Provide detailed, step-by-step explanations when helpful.");
    }
    if (preferences.aiLanguage === "ja") {
      parts.push("Respond in Japanese.");
    } else if (preferences.aiLanguage === "en") {
      parts.push("Respond in English.");
    }
    const text = parts.join("\n");
    return text || undefined;
  };

  const currentMessages = Array.isArray(chats[activeChatId]?.messages) ? chats[activeChatId].messages : [];
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => { chatsRef.current = chats; }, [chats]);
  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);

  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 320; // px, 行数に応じて最大約 12 行程度まで表示
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
  }, [input]);

  useEffect(() => {
    if (currentWatcher?.id && currentSession?.name) {
      const state = loadChatState(currentWatcher.id, currentSession.name);
      setChatIds(state.chatIds);
      setActiveChatId(state.activeChatId);
      setChats(state.chats);
      setSelectedModel(state.selectedModel ?? null);
      setChatMode((state.chatMode as ChatMode) || "ask");
      setThinkingMode((state.thinkingMode as ThinkingMode) || "balanced");
    } else {
      const def = defaultChatState();
      setChatIds(def.chatIds);
      setActiveChatId(def.activeChatId);
      setChats(def.chats);
      setSelectedModel(null);
    }
  }, [currentWatcher?.id, currentSession?.name]);

  const handleChatInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!noSession && !loading && input.trim()) {
        void send(input);
      }
    }
  };

  useEffect(() => {
    if (currentWatcher?.id && currentSession?.name) {
      saveChatState(currentWatcher.id, currentSession.name, {
        chatIds,
        activeChatId,
        chats,
        selectedModel: selectedModel ?? undefined,
        chatMode,
        thinkingMode
      });
    }
  }, [currentWatcher?.id, currentSession?.name, chatIds, activeChatId, chats, selectedModel, chatMode, thinkingMode]);

  useEffect(() => {
    if (!currentWatcher || !currentSession) return;
    let cancelled = false;
    api.getAiModels(currentWatcher.id, currentSession.name).then((r) => {
      if (!cancelled) setAiModels({ installed: r.installed ?? [], suggested: r.suggested ?? [] });
    }).catch(() => {
      if (!cancelled) setAiModels({ installed: [], suggested: [] });
    });
    return () => { cancelled = true; };
  }, [currentWatcher?.id, currentSession?.name]);

  // モデル一覧取得後、まだ選択されていない場合は最初の候補をデフォルト選択にする
  useEffect(() => {
    if (selectedModel) return;
    const fallback = aiModels.suggested[0] ?? aiModels.installed[0] ?? null;
    if (fallback) setSelectedModel(fallback);
  }, [selectedModel, aiModels.suggested, aiModels.installed]);

  useEffect(() => {
    if (!modelDropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) setModelDropdownOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [modelDropdownOpen]);

  const ensureModel = useCallback(async (model: string) => {
    if (!currentWatcher || !currentSession) return false;
    if (aiModels.installed.includes(model)) return true;
    setEnsuringModel(model);
    setInstallProgress({ model, status: "準備中..." });
    try {
      await api.ensureAiModelStream(currentWatcher.id, currentSession.name, model, (ev) => {
        const status = ev.status ?? "処理中...";
        setInstallProgress((prev) =>
          prev?.model === model ? { model, status, percent: ev.percent } : prev
        );
      });
      setAiModels((prev) => ({
        ...prev,
        installed: prev.installed.includes(model) ? prev.installed : [...prev.installed, model]
      }));
      return true;
    } catch {
      return false;
    } finally {
      setEnsuringModel(null);
      setInstallProgress(null);
    }
  }, [currentWatcher?.id, currentSession?.name, aiModels.installed]);

  const selectModel = useCallback(
    async (model: string) => {
      if (model === AUTO_MODEL) {
        setSelectedModel(AUTO_MODEL);
        setModelDropdownOpen(false);
        return;
      }
      const ok = await ensureModel(model);
      if (ok) setSelectedModel(model);
      setModelDropdownOpen(false);
    },
    [ensureModel]
  );

  const send = useCallback(
    async (text: string) => {
      if (!currentWatcher || !currentSession || !text.trim()) return;
      const userMessage = text.trim();
      const mid = activeChatId;
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "user", text: userMessage }] }
      }));
      setInput("");
      setLoading(true);
      try {
        const controller = new AbortController();
        if (aiAbortRef.current) aiAbortRef.current.abort();
        aiAbortRef.current = controller;
        const history = (chats[mid]?.messages ?? []).map((m) => ({ role: m.role, content: m.text }));
        const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
          path: "",
          action: "chat",
          prompt: userMessage,
          fileContent: "",
          history,
          model: selectedModel === AUTO_MODEL ? autoResolved ?? undefined : selectedModel ?? undefined,
          mode: chatMode,
          editorPath: activeEditor.path ?? undefined,
          editorSelectedText: activeEditor.selectedText ?? undefined,
          editorContent: activeEditor.content ?? undefined,
          thinking: thinkingMode,
          persona: buildPersonaInstructions()
        }, { signal: controller.signal });
        const reply = (res as any).result ? String((res as any).result).trim() : "";
        const logs = (res as any).logs as AgentLogEntry[] | undefined;
        if (logs && logs.length) {
          setChats((prev) => {
            const original = prev[mid];
            const anyOriginal = original as any;
            const curLogs = Array.isArray(anyOriginal?.logs) ? (anyOriginal.logs as AgentLogEntry[]) : [];
            return {
              ...prev,
              [mid]: {
                ...(original ?? { name: undefined, messages: [] as Message[] }),
                logs: [...curLogs, ...logs],
              },
            };
          });
        }
        if (res.needsApproval && res.command) {
          setPendingCommand({ command: res.command });
        } else {
          setPendingCommand(null);
        }
        // アニメーション表示: アシスタントメッセージを1文字ずつ伸ばしていく
        setChats((prev) => ({
          ...prev,
          [mid]: {
            ...prev[mid],
            messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: "" }]
          }
        }));
        const speed = 12; // ms / 文字
        let index = 0;
        const timer = window.setInterval(() => {
          index += 1;
          setChats((prev) => {
            const cur = prev[mid];
            if (!cur) return prev;
            const msgs = cur.messages ?? [];
            if (!msgs.length) return prev;
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return prev;
            const nextLast = { ...last, text: reply.slice(0, index) };
            const nextMsgs = [...msgs.slice(0, -1), nextLast];
            return {
              ...prev,
              [mid]: { ...cur, messages: nextMsgs }
            };
          });
          if (index >= reply.length) {
            window.clearInterval(timer);
            setTimeout(scrollToBottom, 50);
          }
        }, speed);
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          // ユーザーが停止した場合はエラーメッセージを出さない
        } else {
          const errMsg = e instanceof Error ? e.message : "Request failed";
          setChats((prev) => ({
            ...prev,
            [mid]: {
              ...prev[mid],
              messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: `Error: ${errMsg}` }]
            }
          }));
          setTimeout(scrollToBottom, 50);
        }
      } finally {
        if (aiAbortRef.current) aiAbortRef.current = null;
        setLoading(false);
      }
    },
    [currentWatcher?.id, currentSession?.name, activeChatId, chats, selectedModel, chatMode, thinkingMode, activeEditor.path, activeEditor.selectedText, activeEditor.content]
  );

  const runPendingCommand = useCallback(async () => {
    if (!pendingCommand || !currentWatcher || !currentSession) return;
    const cmd = pendingCommand.command;
    setPendingCommand(null);
    try {
      const out = await api.sendRemoteCommand(currentWatcher.id, currentSession.name, cmd);
      const output = out.output ?? "";
      const exitCode = out.exitCode ?? 0;
      const feedback = `[Command executed]\n$ ${cmd}\n\nExit code: ${exitCode}\n\nOutput:\n${output}`;
      const mid = activeChatIdRef.current;
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "user", text: feedback }] }
      }));
      // Continue agent reasoning automatically
      setLoading(true);
      const base = chatsRef.current[mid]?.messages ?? [];
      const history = [...base, { role: "user" as const, text: feedback }].map((m) => ({ role: m.role, content: m.text }));
      const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
        path: "",
        action: "chat",
        prompt: "Continue.",
        fileContent: "",
        history,
        model: selectedModel === AUTO_MODEL ? autoResolved ?? undefined : selectedModel ?? undefined,
        mode: chatMode,
        ...(chatMode === "agent" && {
          editorPath: activeEditor.path ?? undefined,
          editorSelectedText: activeEditor.selectedText ?? undefined,
          editorContent: activeEditor.content ?? undefined
        }),
        thinking: thinkingMode,
        persona: buildPersonaInstructions()
      });
      const reply = (res.result ?? "").trim();
      if (res.needsApproval && res.command) setPendingCommand({ command: res.command });
      const replyText =
        res.needsApproval && res.command && !reply
          ? `コマンドを実行して確認します。\n\n提案コマンド: ${res.command}`
          : reply || "(no response)";
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: replyText }] }
      }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Command failed";
      const mid = activeChatId;
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: `Error: ${errMsg}` }] }
      }));
    } finally {
      setLoading(false);
    }
  }, [pendingCommand, currentWatcher?.id, currentSession?.name, selectedModel, chatMode, thinkingMode, activeEditor.path, activeEditor.selectedText, activeEditor.content]);

  const skipPendingCommand = useCallback(async () => {
    if (!pendingCommand || !currentWatcher || !currentSession) return;
    const cmd = pendingCommand.command;
    setPendingCommand(null);
    const mid = activeChatIdRef.current;
    const feedback = `[Command skipped]\n$ ${cmd}\n\nReason: user denied execution. Continue without running commands and answer based on reasoning only.`;
    setChats((prev) => ({
      ...prev,
      [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "user", text: feedback }] }
    }));
    try {
      setLoading(true);
      const base = chatsRef.current[mid]?.messages ?? [];
      const history = [...base, { role: "user" as const, text: feedback }].map((m) => ({ role: m.role, content: m.text }));
      const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
        path: "",
        action: "chat",
        prompt: "Continue.",
        fileContent: "",
        history,
        model: selectedModel === AUTO_MODEL ? autoResolved ?? undefined : selectedModel ?? undefined,
        mode: chatMode,
        thinking: thinkingMode,
        persona: buildPersonaInstructions()
      });
      const reply = (res.result ?? "").trim();
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: reply || "(no response)" }] }
      }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Request failed";
      setChats((prev) => ({
        ...prev,
        [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: `Error: ${errMsg}` }] }
      }));
    } finally {
      setLoading(false);
    }
  }, [pendingCommand, currentWatcher?.id, currentSession?.name, selectedModel, chatMode, thinkingMode]);

  const handleNewChat = () => {
    const id = crypto.randomUUID();
    setChatIds((prev) => [...prev, id]);
    setActiveChatId(id);
    setChats((prev) => ({ ...prev, [id]: { messages: [] } }));
  };

  const handleCloseChat = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const idx = chatIds.indexOf(id);
    if (idx === -1) return;
    const nextIds = chatIds.filter((cid) => cid !== id);
    if (nextIds.length === 0) {
      const newId = crypto.randomUUID();
      setChatIds([newId]);
      setActiveChatId(newId);
      setChats({ [newId]: { messages: [] } });
    } else {
      setChatIds(nextIds);
      if (activeChatId === id) {
        setActiveChatId(nextIds[Math.min(idx, nextIds.length - 1)]);
      }
      setChats((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !loading) void send(input);
  };

  const chatModeOptions: { id: ChatMode; label: string; title: string }[] = [
    { id: "agent", label: "Agent", title: "自律的にタスクを分解して実行" },
    { id: "plan", label: "Plan", title: "計画・ステップの整理" },
    { id: "debug", label: "Debug", title: "デバッグ・原因調査" },
    { id: "ask", label: "Ask", title: "シンプルな質問応答" }
  ];

  const thinkingOptions: { id: ThinkingMode; label: string; title: string }[] = [
    { id: "quick", label: "Quick", title: "Quick（速く・浅く）" },
    { id: "balanced", label: "Balanced", title: "Balanced（標準）" },
    { id: "deep", label: "Deep", title: "Deep（じっくり推論）" }
  ];

  const currentChatModeMeta = chatModeOptions.find((o) => o.id === chatMode);
  const currentThinkingMeta = thinkingOptions.find((o) => o.id === thinkingMode);

  const handleAiAssist = useCallback(async () => {
    if (!currentWatcher || !currentSession) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
        path: activeEditor.path ?? "",
        action: aiAction,
        prompt: aiPrompt.trim() || "Improve this code",
        selectedText: activeEditor.selectedText,
        fileContent: activeEditor.content,
        model: selectedModel === AUTO_MODEL ? autoResolved ?? undefined : selectedModel ?? undefined,
        mode: chatMode,
        thinking: thinkingMode,
        persona: buildPersonaInstructions()
      });
      setAiResult(res.result || "");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI assist failed");
    } finally {
      setAiLoading(false);
    }
  }, [currentWatcher?.id, currentSession?.name, activeEditor.path, activeEditor.selectedText, activeEditor.content, aiAction, aiPrompt, selectedModel, chatMode, thinkingMode]);

  const close = () => updatePreferences({ showAiChatPanel: false });

  const noSession = !currentWatcher || !currentSession;
  const autoResolved = pickAutoModel(aiModels, chatMode, thinkingMode);
  const effectiveModel = selectedModel === AUTO_MODEL ? autoResolved : selectedModel ?? aiModels.suggested[0] ?? "";
  const displayModel =
    selectedModel === AUTO_MODEL ? (autoResolved ? `Auto (${autoResolved})` : "Auto") : effectiveModel ?? "";
  const modelLabelShort =
    selectedModel === AUTO_MODEL
      ? "Auto"
      : effectiveModel
      ? effectiveModel.length > 22
        ? `${effectiveModel.slice(0, 20)}…`
        : effectiveModel
      : "Model";
  const modelOptions = [
    ...(selectedModel &&
    selectedModel !== AUTO_MODEL &&
    !aiModels.suggested.includes(selectedModel) &&
    !aiModels.installed.includes(selectedModel)
      ? [selectedModel]
      : []),
    ...Array.from(new Set([...aiModels.suggested, ...aiModels.installed]))
  ];

  return (
    <div className="pane pane-right ai-chat-pane">
      <div className="pane-header pane-header-with-tabs">
        <div className="pane-header-left">
          <span className="pane-title">AI</span>
          <div className="ai-pane-tabs">
            <button
              type="button"
              className={`editor-tab${tab === "chat" ? " active" : ""}`}
              onClick={() => setTab("chat")}
            >
              チャット
            </button>
            <button
              type="button"
              className={`editor-tab${tab === "assist" ? " active" : ""}`}
              onClick={() => setTab("assist")}
            >
              アシスト
            </button>
            <button
              type="button"
              className={`editor-tab${tab === "settings" ? " active" : ""}`}
              onClick={() => setTab("settings")}
            >
              設定
            </button>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={close} title="閉じる">
          ×
        </button>
      </div>
        <div className="ai-chat-body">
        {/* Assist タブ用のグローバル thinking 表示（チャットタブではバブル内に表示する） */}
        {tab === "assist" && (loading || aiLoading) && (
          <div className="ai-thinking-indicator" aria-live="polite">
            <div className="ai-thinking-spinner" aria-hidden />
            <div className="ai-thinking-text">
              <span>thinking</span>
              <span className="ai-thinking-dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
              <span className="ai-thinking-detail">
                {thinkingMode === "deep"
                  ? "performing a deeper multi-step analysis…"
                  : "generating a code edit suggestion…"}
              </span>
            </div>
          </div>
        )}
        {tab === "settings" && (
          <div className="ai-settings-tab">
            <div className="ai-settings-section">
              <label className="ai-settings-label">ペルソナ / 追加指示</label>
              <p className="ai-settings-hint">
                AI の振る舞いを変えるための指示を書けます。チャット・アシスト両方のシステムプロンプトの先頭に付与されます。
              </p>
              <textarea
                className="ai-settings-persona"
                value={preferences.aiPersona ?? ""}
                onChange={(e) => updatePreferences({ aiPersona: e.target.value })}
                placeholder="例: あなたは簡潔で実用的なアドバイスをするアシスタントです。"
                rows={6}
              />
            </div>
            <div className="ai-settings-section">
              <label className="ai-settings-label">口調</label>
              <p className="ai-settings-hint">フレンドリー / 厳密 など、応答の雰囲気を指定します。</p>
              <select
                className="ai-settings-select"
                value={preferences.aiTone}
                onChange={(e) => updatePreferences({ aiTone: e.target.value as any })}
              >
                <option value="neutral">標準</option>
                <option value="friendly">フレンドリー</option>
                <option value="strict">厳密・そっけない</option>
              </select>
            </div>
            <div className="ai-settings-section">
              <label className="ai-settings-label">回答の長さ</label>
              <p className="ai-settings-hint">どの程度詳しく答えるかの目安を指定します。</p>
              <select
                className="ai-settings-select"
                value={preferences.aiResponseLength}
                onChange={(e) => updatePreferences({ aiResponseLength: e.target.value as any })}
              >
                <option value="short">短く要点のみ</option>
                <option value="normal">通常</option>
                <option value="detailed">できるだけ詳しく</option>
              </select>
            </div>
            <div className="ai-settings-section">
              <label className="ai-settings-label">優先する言語</label>
              <p className="ai-settings-hint">日本語 / 英語 のどちらで主に応答するかを指定します。</p>
              <select
                className="ai-settings-select"
                value={preferences.aiLanguage}
                onChange={(e) => updatePreferences({ aiLanguage: e.target.value as any })}
              >
                <option value="auto">自動（入力に追従）</option>
                <option value="ja">主に日本語</option>
                <option value="en">主に英語</option>
              </select>
            </div>
          </div>
        )}
        {tab === "chat" && (
        <>
        <div className="ai-chat-tab-row">
          {chatIds.map((id) => (
            <span key={id} className={`ai-chat-tab-wrap${activeChatId === id ? " active" : ""}`}>
              <button
                type="button"
                className="editor-tab small ai-chat-tab-btn"
                onClick={() => setActiveChatId(id)}
                title={chats[id]?.messages[0]?.text?.slice(0, 30) ?? "New chat"}
              >
                {chats[id]?.messages[0]?.text?.slice(0, 12) ?? "New"} {chats[id]?.messages?.length ? `(${chats[id].messages.length})` : ""}
              </button>
              <button
                type="button"
                className="ai-chat-tab-close"
                onClick={(e) => handleCloseChat(e, id)}
                title="このチャットを削除"
                aria-label="削除"
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="editor-tab small new-chat-tab" onClick={handleNewChat} title="New Chat">
            + New
          </button>
        </div>
        <div className="ai-chat-subtabs">
          <button
            type="button"
            className={`ai-chat-subtab${chatView === "messages" ? " active" : ""}`}
            onClick={() => setChatView("messages")}
          >
            Chat
          </button>
          <button
            type="button"
            className={`ai-chat-subtab${chatView === "logs" ? " active" : ""}`}
            onClick={() => setChatView("logs")}
          >
            Logs
          </button>
        </div>
        <div className="ai-chat-messages">
          {chatView === "messages" && pendingCommand && (
            <div className="ai-chat-msg ai-chat-msg-assistant">
              <span className="ai-chat-msg-role">AI</span>
              <div className="ai-chat-command-card">
                <div className="ai-chat-command-title">コマンド実行の確認</div>
                <pre className="ai-chat-command">{pendingCommand.command}</pre>
                <div className="ai-chat-command-actions">
                  <button type="button" className="primary-button" onClick={() => void runPendingCommand()} disabled={loading}>
                    実行
                  </button>
                  <button type="button" className="icon-button" style={{ width: "auto", padding: "0 0.6rem" }} onClick={() => void skipPendingCommand()} disabled={loading}>
                    スキップ
                  </button>
                </div>
              </div>
            </div>
          )}
          {chatView === "messages" &&
            currentMessages.map((m, i) => {
            const segs = splitMarkdownCodeFences(m.text);
            return (
              <div key={i} className={`ai-chat-msg ai-chat-msg-${m.role}`}>
                <span className="ai-chat-msg-role">{m.role === "user" ? "You" : "AI"}</span>
                {segs.map((s, idx) => {
                  if (s.kind === "text") {
                    const t = s.text.trimEnd();
                    if (!t) return null;
                    const html = marked.parse(t, { breaks: true }) as string;
                    return (
                      <div
                        key={idx}
                        className="ai-chat-msg-text"
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    );
                  }
                  const lang = normalizePrismLanguage(s.language);
                  const grammar = Prism.languages[lang] || Prism.languages.plaintext || Prism.languages.markup;
                  const highlighted = Prism.highlight(s.code, grammar, lang);
                  if (m.role !== "assistant") {
                    return (
                      <pre key={idx} className="ai-chat-code">
                        <code
                          className={`language-${lang}`}
                          dangerouslySetInnerHTML={{ __html: highlighted }}
                        />
                      </pre>
                    );
                  }
                  return (
                    <div key={idx} className="ai-chat-code-wrap">
                      <div className="ai-chat-code-actions">
                        <button
                          type="button"
                          className="icon-button ai-mini-icon-btn"
                          onClick={() => applyToSelection(s.code)}
                          title="Apply to selection"
                          aria-label="Apply to selection"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="icon-button ai-mini-icon-btn"
                          onClick={() => appendAtCursor(s.code)}
                          title="Insert at cursor"
                          aria-label="Insert at cursor"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14" /><path d="M5 12h14" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="icon-button ai-mini-icon-btn"
                          onClick={() => navigator.clipboard?.writeText(s.code)}
                          title="Copy"
                          aria-label="Copy"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                      <pre className="ai-chat-code">
                        <code
                          className={`language-${lang}`}
                          dangerouslySetInnerHTML={{ __html: highlighted }}
                        />
                      </pre>
                    </div>
                  );
                })}
              </div>
            );
            })}
          {chatView === "logs" && (
            <div className="ai-chat-logs">
              {Array.isArray((chats[activeChatId] as any)?.logs) && (chats[activeChatId] as any).logs.length === 0 && (
                <div className="ai-chat-inline-note">No agent commands have been executed yet.</div>
              )}
              {Array.isArray((chats[activeChatId] as any)?.logs) &&
                ((chats[activeChatId] as any).logs as AgentLogEntry[]).map((log, idx) => (
                <div key={idx} className="ai-chat-log-entry">
                  <div className="ai-chat-log-header">
                    <span className="ai-chat-log-label">Command</span>
                    {typeof log.exitCode === "number" && (
                      <span className={`ai-chat-log-exit${log.exitCode === 0 ? " ok" : " ng"}`}>
                        exit {log.exitCode}
                      </span>
                    )}
                  </div>
                  <pre className="ai-chat-command">
                    <code>$ {log.command}</code>
                  </pre>
                  {log.error && (
                    <div className="ai-chat-log-error">
                      {log.error}
                    </div>
                  )}
                  {log.output && (
                    <pre className="ai-chat-log-output">
                      {log.output}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {loading && tab === "chat" && (
            <div className="ai-chat-msg ai-chat-msg-assistant">
              <span className="ai-chat-msg-role">AI</span>
              <div className="ai-chat-msg-text">
                <div className="ai-thinking-indicator" aria-live="polite">
                  <div className="ai-thinking-spinner" aria-hidden />
                  <div className="ai-thinking-text">
                    <span>thinking</span>
                    <span className="ai-thinking-dots">
                      <span>.</span>
                      <span>.</span>
                      <span>.</span>
                    </span>
                    {chatMode === "agent" && (
                      <span className="ai-thinking-detail">
                        {pendingCommand
                          ? "waiting for command approval…"
                          : "analyzing context and may run safe commands on the remote session…"}
                      </span>
                    )}
                    {chatMode !== "agent" && (
                      <span className="ai-thinking-detail">
                        {thinkingMode === "deep"
                          ? "performing a deeper multi-step analysis…"
                          : "generating a response…"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <form className="ai-chat-form" onSubmit={handleSubmit}>
          <div className="ai-chat-composer">
            <textarea
              ref={chatInputRef}
              className="ai-chat-input"
              placeholder={noSession ? "Watcher / Session を選択してください" : "メッセージを入力"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleChatInputKeyDown}
              disabled={noSession || loading}
            />
            <div className="ai-chat-composer-footer">
              <div className="ai-chat-composer-left">
                <div className="ai-chat-mode-dropdown">
                  <button
                    type="button"
                    className="ai-mode-chip"
                    onClick={() => setModeMenuOpen((o) => !o)}
                    title={currentChatModeMeta?.title}
                    aria-label={currentChatModeMeta?.label}
                  >
                    <span aria-hidden>
                      {chatMode === "agent" && (
                        <svg viewBox="0 0 24 24">
                          <circle cx="12" cy="6" r="3" />
                          <circle cx="6" cy="16" r="3" />
                          <circle cx="18" cy="16" r="3" />
                          <path d="M10 8.5 8 13.5M14 8.5l2 5M9 16h6" />
                        </svg>
                      )}
                      {chatMode === "plan" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M6 6h12M6 12h12M6 18h12" />
                          <circle cx="6" cy="6" r="1.2" />
                          <circle cx="6" cy="12" r="1.2" />
                          <circle cx="6" cy="18" r="1.2" />
                        </svg>
                      )}
                      {chatMode === "debug" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M9 5h6" />
                          <rect x="7" y="7" width="10" height="10" rx="3" />
                          <path d="M7 9 4 7M17 9l3-2M7 15 4 17M17 15l3 2" />
                        </svg>
                      )}
                      {chatMode === "ask" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
                        </svg>
                      )}
                    </span>
                  </button>
                  {modeMenuOpen && (
                    <div className="ai-chat-mode-menu">
                      {chatModeOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ai-chat-mode-menu-item${chatMode === opt.id ? " active" : ""}`}
                          onClick={() => {
                            setChatMode(opt.id);
                            setModeMenuOpen(false);
                          }}
                        >
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ai-chat-mode-dropdown">
                  <button
                    type="button"
                    className="ai-thinking-chip"
                    onClick={() => setThinkingMenuOpen((o) => !o)}
                    title={currentThinkingMeta?.title}
                    aria-label={currentThinkingMeta?.label}
                  >
                    <span aria-hidden>
                      {thinkingMode === "quick" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M4 12h10" />
                          <path d="M4 8h6" />
                        </svg>
                      )}
                      {thinkingMode === "balanced" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M4 12h16" />
                          <circle cx="12" cy="12" r="2.3" />
                        </svg>
                      )}
                      {thinkingMode === "deep" && (
                        <svg viewBox="0 0 24 24">
                          <path d="M4 10c2-3 6-3 8 0s6 3 8 0" />
                          <path d="M4 15c2-3 6-3 8 0s6 3 8 0" />
                        </svg>
                      )}
                    </span>
                  </button>
                  {thinkingMenuOpen && (
                    <div className="ai-chat-mode-menu">
                      {thinkingOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ai-chat-mode-menu-item${thinkingMode === opt.id ? " active" : ""}`}
                          onClick={() => {
                            setThinkingMode(opt.id);
                            setThinkingMenuOpen(false);
                          }}
                        >
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ai-chat-form-left" ref={modelDropdownRef}>
                  <div className="ai-chat-model-dropdown">
                    <button
                      type="button"
                      className="icon-button ai-model-btn"
                      onClick={() => setModelDropdownOpen((o) => !o)}
                      title={displayModel || "モデルを選択"}
                      aria-label={displayModel || "モデルを選択"}
                      disabled={noSession}
                    >
                      <span className="ai-model-icon" aria-hidden>
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M7 7h10a2 2 0 0 1 2 2v0.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
                          <path d="M7 15h6a2 2 0 0 0 2-2v0a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2Z" />
                          <path d="M9 9.5h2.5M9 15h2" />
                        </svg>
                      </span>
                      <span className="sr-only">
                        {displayModel || "Model"}
                      </span>
                    </button>
                    <span className="ai-chat-model-text">
                      {modelLabelShort}
                    </span>
                    {modelDropdownOpen && (
                      <div className="ai-chat-model-menu">
                        {installProgress && (
                          <div className="ai-chat-model-ensuring">
                            {installProgress.model} … {installProgress.percent != null ? `${installProgress.percent}%` : installProgress.status}
                          </div>
                        )}
                        {/* Auto モデル（ダウンロード済みの中から自動選択） */}
                        <button
                          key={AUTO_MODEL}
                          type="button"
                          className={`ai-chat-model-option${selectedModel === AUTO_MODEL ? " active" : ""}`}
                          onClick={() => void selectModel(AUTO_MODEL)}
                          disabled={ensuringModel !== null}
                          title={autoResolved ? `Auto (${autoResolved})` : "Auto"}
                        >
                          <span className="ai-chat-model-option-check" aria-hidden>
                            {selectedModel === AUTO_MODEL ? "✓" : ""}
                          </span>
                          <span className="ai-chat-model-option-label">
                            {autoResolved ? `Auto (${autoResolved})` : "Auto"}
                          </span>
                        </button>
                        {modelOptions.map((m) => (
                          <button
                            key={m}
                            type="button"
                            className={`ai-chat-model-option${selectedModel === m ? " active" : ""}`}
                            onClick={() => void selectModel(m)}
                            disabled={ensuringModel !== null}
                            title={m}
                          >
                            <span className="ai-chat-model-option-check" aria-hidden>
                              {selectedModel === m ? "✓" : ""}
                            </span>
                            <span className="ai-chat-model-option-label">
                              {m}
                              {aiModels.installed.includes(m) ? "" : " (未インストール)"}
                            </span>
                          </button>
                        ))}
                        {modelOptions.length === 0 && !ensuringModel && (
                          <div className="ai-chat-model-option muted">利用可能なモデルがありません</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="ai-chat-composer-right">
                <button
                  type="button"
                  className="ai-chat-send-btn"
                  onClick={() => {
                    if (loading) {
                      if (aiAbortRef.current) {
                        aiAbortRef.current.abort();
                        aiAbortRef.current = null;
                      }
                      setLoading(false);
                    } else if (!noSession && input.trim()) {
                      void send(input);
                    }
                  }}
                  disabled={noSession || (!loading && !input.trim())}
                  title={loading ? "停止" : "送信"}
                  aria-label={loading ? "停止" : "送信"}
                >
                  {loading ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="5" y="5" width="14" height="14" fill="#ffffff" rx="3" ry="3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 18L12 5l7 13z" fill="#ffffff" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </form>
        </>
        )}
        {tab === "assist" && (
          <div className="ai-assist-section">
            <div className="ai-chat-verify">
              <div className="ai-chat-verify-title">エディタのコードを AI で編集</div>
              {activeEditor.path && (
                <div className="ai-chat-inline-note" style={{ marginBottom: "0.35rem" }}>
                  対象: {activeEditor.path}
                </div>
              )}
              {!activeEditor.path && (
                <div className="ai-chat-inline-note" style={{ marginBottom: "0.35rem" }}>
                  エディタでファイルを開いてから実行してください。
                </div>
              )}
            </div>
            <div className="ai-chat-mode-row ai-chat-mode-row--icons" style={{ marginBottom: "0.5rem" }}>
              <div className="ai-chat-mode-group" aria-label="モード" role="radiogroup">
                {chatModeOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ai-mode-chip${chatMode === opt.id ? " active" : ""}`}
                    onClick={() => setChatMode(opt.id)}
                    title={opt.title}
                    aria-pressed={chatMode === opt.id}
                  >
                    {opt.id === "agent" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <circle cx="12" cy="6" r="3" />
                          <circle cx="6" cy="16" r="3" />
                          <circle cx="18" cy="16" r="3" />
                          <path d="M10 8.5 8 13.5M14 8.5l2 5M9 16h6" />
                        </svg>
                      </span>
                    )}
                    {opt.id === "plan" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M6 6h12M6 12h12M6 18h12" />
                          <circle cx="6" cy="6" r="1.2" />
                          <circle cx="6" cy="12" r="1.2" />
                          <circle cx="6" cy="18" r="1.2" />
                        </svg>
                      </span>
                    )}
                    {opt.id === "debug" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M9 5h6" />
                          <rect x="7" y="7" width="10" height="10" rx="3" />
                          <path d="M7 9 4 7M17 9l3-2M7 15 4 17M17 15l3 2" />
                        </svg>
                      </span>
                    )}
                    {opt.id === "ask" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
                        </svg>
                      </span>
                    )}
                    <span className="sr-only">{opt.label}</span>
                  </button>
                ))}
              </div>
              <div className="ai-chat-mode-group" aria-label="思考レベル" role="radiogroup">
                {thinkingOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ai-thinking-chip${thinkingMode === opt.id ? " active" : ""}`}
                    onClick={() => setThinkingMode(opt.id)}
                    title={opt.title}
                    aria-pressed={thinkingMode === opt.id}
                  >
                    {opt.id === "quick" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M4 12h10" />
                          <path d="M4 8h6" />
                        </svg>
                      </span>
                    )}
                    {opt.id === "balanced" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M4 12h16" />
                          <circle cx="12" cy="12" r="2.3" />
                        </svg>
                      </span>
                    )}
                    {opt.id === "deep" && (
                      <span aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M4 10c2-3 6-3 8 0s6 3 8 0" />
                          <path d="M4 15c2-3 6-3 8 0s6 3 8 0" />
                        </svg>
                      </span>
                    )}
                    <span className="sr-only">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="ai-assist-controls">
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
              </div>
              <div className="ai-assist-row-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={noSession || aiLoading || !activeEditor.path}
                  onClick={() => void handleAiAssist()}
                >
                  {aiLoading ? "Thinking..." : "AI Assist"}
                </button>
              </div>
            </div>
            {aiError && (
              <div className="ai-chat-test-result ng" style={{ marginTop: "0.35rem" }}>{aiError}</div>
            )}
            {aiResult && (
              <div className="ai-assist-result">
                <div className="ai-assist-actions">
                  <button
                    type="button"
                    className="icon-button"
                    style={{ width: "auto", padding: "0 0.5rem" }}
                    onClick={() => {
                      const segs = splitMarkdownCodeFences(aiResult);
                      const firstCode = segs.find((s) => s.kind === "code") as Extract<MsgSegment, { kind: "code" }> | undefined;
                      applyToSelection(firstCode?.code ?? aiResult);
                    }}
                  >
                    Replace Selection
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    style={{ width: "auto", padding: "0 0.5rem" }}
                    onClick={() => {
                      const segs = splitMarkdownCodeFences(aiResult);
                      const firstCode = segs.find((s) => s.kind === "code") as Extract<MsgSegment, { kind: "code" }> | undefined;
                      appendAtCursor(firstCode?.code ?? aiResult);
                    }}
                  >
                    Append Result
                  </button>
                </div>
                <div className="ai-assist-body">
                  {splitMarkdownCodeFences(aiResult).map((s, idx) => {
                    if (s.kind === "text") {
                      const t = s.text.trim();
                      if (!t) return null;
                      return (
                        <pre key={idx} className="ai-chat-msg-text">{t}</pre>
                      );
                    }
                    return (
                      <pre key={idx} className="ai-chat-code">{s.code}</pre>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
