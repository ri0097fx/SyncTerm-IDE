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
import { api, type BuddyState } from "../../lib/api";

type Message = { role: "user" | "assistant"; text: string; feedback?: "good" | "bad" };
type PendingCommand = { command: string; chatId: string };
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

export type ChatMode = "agent" | "plan" | "debug" | "ask" | "multi";
export type ThinkingMode = "quick" | "balanced" | "deep";

type ChatState = {
  chatIds: string[];
  activeChatId: string;
  chats: Record<
    string,
    {
      name?: string;
      messages: Message[];
      logs?: AgentLogEntry[];
      debates?: {
        id: string;
        title?: string;
        models: string[];
        turns: { round: number; speaker: string; model: string; role: string; content: string }[];
      }[];
    }
  >;
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
  const [tab, setTab] = useState<"chat" | "assist" | "buddy" | "settings">("chat");
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [chats, setChats] = useState<
    Record<
      string,
      {
        name?: string;
        messages: Message[];
        logs?: AgentLogEntry[];
        debates?: {
          id: string;
          title?: string;
          models: string[];
          turns: { round: number; speaker: string; model: string; role: string; content: string }[];
        }[];
      }
    >
  >({});
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
  const [aiModels, setAiModels] = useState<{ installed: string[]; suggested: string[]; recommended?: string[] }>({
    installed: [],
    suggested: [],
    recommended: []
  });
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [ensuringModel, setEnsuringModel] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ model: string; status: string; percent?: number } | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [chatView, setChatView] = useState<"messages" | "logs" | "debate">("messages");
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [buddyState, setBuddyState] = useState<BuddyState | null>(null);
  const [buddyMessages, setBuddyMessages] = useState<Message[]>([]);
  const [buddyInput, setBuddyInput] = useState("");
  const [buddyLoading, setBuddyLoading] = useState(false);
  const [buddySuggestedTasks, setBuddySuggestedTasks] = useState<string[]>([]);
  const [buddyTasksError, setBuddyTasksError] = useState<string | null>(null);
  const [buddyTasksLoading, setBuddyTasksLoading] = useState(false);
  const [buddyAllowCommands, setBuddyAllowCommands] = useState(false);
  const [showAdvancedPersona, setShowAdvancedPersona] = useState(false);
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
    if (preferences.aiExecutionStyle === "careful") {
      parts.push("Prefer cautious, incremental changes and double-check risky operations with the user before proceeding.");
    } else if (preferences.aiExecutionStyle === "bold") {
      parts.push("Be more proactive in proposing larger refactors or concrete code edits, while still calling out risks clearly.");
    }
    if (preferences.aiQuestioningStyle === "proactive") {
      parts.push("Ask clarifying questions when the request is ambiguous or under-specified instead of guessing.");
    } else if (preferences.aiQuestioningStyle === "minimal") {
      parts.push("Avoid too many clarification questions; make reasonable assumptions and minimize interruptions.");
    }
    if (preferences.aiExplainStyle === "high_level") {
      parts.push("Prefer high-level explanations and summaries; avoid unnecessary low-level step-by-step detail.");
    } else if (preferences.aiExplainStyle === "step_by_step") {
      parts.push("Explain your reasoning and solutions step by step so the user can follow the process.");
    }
    if (buddyState && buddyState.hints && buddyState.hints.length) {
      const enabledHints = buddyState.hints;
      if (enabledHints.length) {
        parts.push(
          "Learned preferences (from past feedback):\n" +
            enabledHints.map((h) => `- ${h.text}`).join("\n")
        );
      }
    }
    const text = parts.join("\n");
    return text || undefined;
  };

  const currentMessages = Array.isArray(chats[activeChatId]?.messages) ? chats[activeChatId].messages : [];
  const currentDebates = Array.isArray((chats[activeChatId] as any)?.debates)
    ? ((chats[activeChatId] as any).debates as {
        id: string;
        title?: string;
        models: string[];
        turns: { round: number; speaker: string; model: string; role: string; content: string }[];
      }[])
    : [];
  const [debateForNextCycle, setDebateForNextCycle] = useState<{
    id: string;
    title?: string;
    models: string[];
    turns: { round: number; speaker: string; model: string; role: string; content: string }[];
  } | null>(null);
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
    // 日本語入力など IME 変換中の Enter では送信しない
    if ((e.nativeEvent as any).isComposing || e.key === "Process") {
      return;
    }
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
    api
      .getAiModels(currentWatcher.id, currentSession.name)
      .then((r) => {
        if (!cancelled)
          setAiModels({
            installed: r.installed ?? [],
            suggested: r.suggested ?? [],
            recommended: r.recommended ?? []
          });
      })
      .catch(() => {
        if (!cancelled) setAiModels({ installed: [], suggested: [], recommended: [] });
      });
    return () => {
      cancelled = true;
    };
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
    async (text: string, options?: { historyBeforeIndex?: number }) => {
      if (!currentWatcher || !currentSession || !text.trim()) return;
      const rawUserMessage = text.trim();
      let apiPrompt = rawUserMessage;

      // 追加サイクル（前回ディベートを踏まえた再ディベート）の場合は、
      // 前回ディベートのログをプロンプトに埋め込んでから送信する
      if (debateForNextCycle && chatMode === "multi") {
        const d = debateForNextCycle;
        const turnsText = d.turns
          .map(
            (t) =>
              `Round ${t.round} · ${t.speaker} (${t.model}):\n${t.content || "(no content)"}`
          )
          .join("\n\n---\n\n");
        const userExtra =
          rawUserMessage && rawUserMessage.length > 0
            ? `ユーザーからの追加コメント:\n${rawUserMessage}`
            : "ユーザーからの追加コメントはありません。";
        apiPrompt =
          "以下は前回のマルチモデル・ディベートのログです。これを前提知識として扱い、必要であれば内容を修正・発展させてください。\n\n" +
          turnsText +
          "\n\n---\n\n" +
          userExtra +
          "\n\nこれらを踏まえて、改めて最良の回答を出してください。";
        setDebateForNextCycle(null);
      }

      const mid = activeChatId;
      const prevMessages = chats[mid]?.messages ?? [];
      const historyForApi =
        options?.historyBeforeIndex != null
          ? prevMessages.slice(0, options.historyBeforeIndex)
          : prevMessages;
      if (options?.historyBeforeIndex != null) {
        setChats((prev) => ({
          ...prev,
          [mid]: {
            ...prev[mid],
            messages: [
              ...prevMessages.slice(0, options.historyBeforeIndex!),
              { role: "user", text: rawUserMessage }
            ]
          }
        }));
      } else {
        setChats((prev) => ({
          ...prev,
          [mid]: {
            ...prev[mid],
            messages: [...(prev[mid]?.messages ?? []), { role: "user", text: rawUserMessage }]
          }
        }));
      }
      setInput("");
      setLoading(true);
      try {
        const controller = new AbortController();
        if (aiAbortRef.current) aiAbortRef.current.abort();
        aiAbortRef.current = controller;
        const history = historyForApi.map((m) => ({ role: m.role, content: m.text }));
        // ストリーミング用に、空のアシスタントメッセージを 1 つ追加しておく
        setChats((prev) => ({
          ...prev,
          [mid]: {
            ...prev[mid],
            messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: "" }]
          }
        }));
        await api.streamAi(
          currentWatcher.id,
          currentSession.name,
          {
            path: "",
            action: "chat",
            prompt: apiPrompt,
            fileContent: "",
            history,
            model: buildModelForPayload(),
            mode: chatMode,
            editorPath: activeEditor.path ?? undefined,
            editorSelectedText: activeEditor.selectedText ?? undefined,
            editorContent: activeEditor.content ?? undefined,
            thinking: thinkingMode,
            persona: buildPersonaInstructions(),
            hybridRouting: preferences.aiHybridRouting || undefined
          },
          (ev) => {
            if (ev.type === "token" && ev.delta) {
              setChats((prev) => {
                const cur = prev[mid];
                if (!cur) return prev;
                const msgs = cur.messages ?? [];
                if (!msgs.length) return prev;
                const last = msgs[msgs.length - 1];
                if (!last || last.role !== "assistant") return prev;
                const nextLast = { ...last, text: (last.text ?? "") + ev.delta };
                const nextMsgs = [...msgs.slice(0, -1), nextLast];
                return {
                  ...prev,
                  [mid]: { ...cur, messages: nextMsgs }
                };
              });
            }
            if (ev.type === "debate_turn" && ev.debateId && ev.turn) {
              setChats((prev) => {
                const cur = prev[mid] || { name: undefined, messages: [] as Message[] };
                const existingDebates =
                  Array.isArray((cur as any).debates) && (cur as any).debates.length
                    ? ((cur as any).debates as {
                        id: string;
                        title?: string;
                        models: string[];
                        turns: { round: number; speaker: string; model: string; role: string; content: string }[];
                      }[])
                    : [];
                const idx = existingDebates.findIndex((d) => d.id === ev.debateId);
                let nextDebates = existingDebates.slice();
                if (idx === -1) {
                  nextDebates = [
                    ...existingDebates,
                    {
                      id: ev.debateId!,
                      title: "Multi-model debate",
                      models: [],
                      turns: [ev.turn!],
                    },
                  ];
                } else {
                  const d = nextDebates[idx]!;
                  nextDebates[idx] = { ...d, turns: [...d.turns, ev.turn!] };
                }
                return {
                  ...prev,
                  [mid]: { ...(cur as any), debates: nextDebates },
                };
              });
            }
            if (ev.type === "done") {
              // token ストリームが空だった場合でも、最終結果は done.result で補完する
              if (ev.result) {
                setChats((prev) => {
                  const cur = prev[mid];
                  if (!cur) return prev;
                  const msgs = cur.messages ?? [];
                  if (!msgs.length) return prev;
                  const last = msgs[msgs.length - 1];
                  if (!last || last.role !== "assistant") return prev;
                  const lastText = (last.text ?? "").trim();
                  if (lastText.length > 0) return prev;
                  const nextLast = { ...last, text: ev.result ?? "" };
                  return { ...prev, [mid]: { ...cur, messages: [...msgs.slice(0, -1), nextLast] } };
                });
              }
              const logs = ev.logs;
              const debates = ev.debates;
              if (logs && logs.length) {
                setChats((prev) => {
                  const original = prev[mid];
                  const curLogs = Array.isArray(original?.logs) ? (original!.logs as AgentLogEntry[]) : [];
                  return {
                    ...prev,
                    [mid]: {
                      ...(original ?? { name: undefined, messages: [] as Message[] }),
                      logs: [...curLogs, ...logs]
                    }
                  };
                });
              }
              if (debates && debates.length) {
                setChats((prev) => {
                  const original = prev[mid];
                  const curDebates = Array.isArray(original?.debates) ? original!.debates! : [];
                  const merged = [...curDebates];
                  for (const d of debates) {
                    if (!d || typeof (d as any).id !== "string") continue;
                    const idx = merged.findIndex((x: any) => x?.id === (d as any).id);
                    if (idx >= 0) merged[idx] = d as any;
                    else merged.push(d as any);
                  }
                  return {
                    ...prev,
                    [mid]: {
                      ...(original ?? { name: undefined, messages: [] as Message[] }),
                      debates: merged
                    }
                  };
                });
              }
              if (ev.needsApproval && ev.command) {
                setPendingCommand({ command: ev.command, chatId: mid });
              } else {
                setPendingCommand(null);
              }
              setTimeout(scrollToBottom, 50);
            }
          },
          { signal: controller.signal }
        );
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

  const rerunMultiDebate = useCallback(
    (debate: {
      id: string;
      title?: string;
      models: string[];
      turns: { round: number; speaker: string; model: string; role: string; content: string }[];
    }) => {
      if (!currentWatcher || !currentSession) return;
      if (chatMode !== "multi") return;
      setDebateForNextCycle(debate);
      // 入力欄にフォーカスし、必要ならテンプレートメッセージを挿入
      setInput((prev) =>
        prev && prev.trim().length > 0
          ? prev
          : "前回のディベート内容を踏まえてもう1サイクル実行します。追記や修正したい点があればここに入力してください。"
      );
      chatInputRef.current?.focus();
    },
    [currentWatcher, currentSession, chatMode]
  );

  const runPendingCommand = useCallback(async () => {
    if (!pendingCommand || !currentWatcher || !currentSession) return;
    const cmd = pendingCommand.command;
    const mid = pendingCommand.chatId || activeChatIdRef.current;
    setPendingCommand(null);
    try {
      const out = await api.sendRemoteCommand(currentWatcher.id, currentSession.name, cmd);
      const output = out.output ?? "";
      const exitCode = out.exitCode ?? 0;
      const feedback = `[Command executed]\n$ ${cmd}\n\nExit code: ${exitCode}\n\nOutput:\n${output}`;
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
        model: buildModelForPayload(),
        mode: chatMode,
        ...(chatMode === "agent" && {
          editorPath: activeEditor.path ?? undefined,
          editorSelectedText: activeEditor.selectedText ?? undefined,
          editorContent: activeEditor.content ?? undefined
        }),
        thinking: thinkingMode,
        persona: buildPersonaInstructions(),
        hybridRouting: preferences.aiHybridRouting || undefined
      });
      const reply = (res.result ?? "").trim();
      if (res.needsApproval && res.command) {
        // 同じコマンドを繰り返し提案している場合はループを防ぐ
        if (res.command.trim() === cmd.trim()) {
          setPendingCommand(null);
        } else {
          setPendingCommand({ command: res.command, chatId: mid });
        }
      }
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

  const sendFeedback = useCallback(
    async (message: Message, rating: "good" | "bad") => {
      if (!message.text.trim()) return;
      try {
        await api.sendAiBuddyFeedback({
          message: message.text,
          role: message.role,
          rating,
          taskType: tab === "assist" ? aiAction : tab === "buddy" ? "buddy_train" : "chat",
          mode: chatMode,
          thinking: thinkingMode,
          model: selectedModel ?? undefined,
          watcherId: currentWatcher?.id,
          session: currentSession?.name
        });
      } catch {
        // ignore feedback errors
      }
    },
    [currentWatcher?.id, currentSession?.name, tab, aiAction, chatMode, thinkingMode, selectedModel]
  );

  const skipPendingCommand = useCallback(async () => {
    if (!pendingCommand || !currentWatcher || !currentSession) return;
    const cmd = pendingCommand.command;
    const mid = pendingCommand.chatId || activeChatIdRef.current;
    setPendingCommand(null);
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
        model: buildModelForPayload(),
        mode: chatMode,
        thinking: thinkingMode,
        persona: buildPersonaInstructions(),
        hybridRouting: preferences.aiHybridRouting || undefined
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

  const sendBuddy = useCallback(
    async (text: string) => {
      if (!currentWatcher || !currentSession || !text.trim()) return;
      const userMessage = text.trim();
      const prev = buddyMessages;
      const history = prev.map((m) => ({ role: m.role, content: m.text }));
      setBuddyMessages((msgs) => [...msgs, { role: "user", text: userMessage }]);
      setBuddyInput("");
      setBuddyLoading(true);
      try {
        const modeForBuddy = buddyAllowCommands ? "agent" : "ask";
        const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
          path: activeEditor.path ?? "",
          action: "chat",
          prompt: userMessage,
          fileContent: activeEditor.content ?? "",
          history,
          model: buildModelForPayload(),
          mode: modeForBuddy,
          ...(modeForBuddy === "agent" && {
            editorPath: activeEditor.path ?? undefined,
            editorSelectedText: activeEditor.selectedText ?? undefined,
            editorContent: activeEditor.content ?? undefined
          }),
          thinking: thinkingMode,
          persona: buildPersonaInstructions(),
          hybridRouting: preferences.aiHybridRouting || undefined
        });
        const reply = (res.result ?? "").trim() || "(no response)";
        setBuddyMessages((msgs) => [...msgs, { role: "assistant", text: reply }]);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Request failed";
        setBuddyMessages((msgs) => [...msgs, { role: "assistant", text: `Error: ${errMsg}` }]);
      } finally {
        setBuddyLoading(false);
      }
    },
    [
      currentWatcher?.id,
      currentSession?.name,
      buddyMessages,
      selectedModel,
      thinkingMode,
      buddyAllowCommands,
      activeEditor.path,
      activeEditor.selectedText,
      activeEditor.content
    ]
  );

  const generateBuddyTasks = useCallback(
    async () => {
      if (!currentWatcher || !currentSession) {
        setBuddyTasksError("Watcher / Session が未接続のため、練習タスクを生成できません。まず左上で接続してください。");
        return;
      }
      setBuddyTasksLoading(true);
      setBuddyTasksError(null);
      try {
        const prompt =
          "あなたは Buddy AI のコーチです。まずは「初級レベル」の、非常に簡単な練習タスクだけを日本語で5個提案してください。" +
          "・対象はこのプロジェクトのようなソフトウェア開発ですが、内容は『1つの関数を読む』『短いエラーメッセージを要約する』など、小さくてシンプルなものに限定してください。" +
          "・各行に1タスクだけを書き、最大30文字程度に短くまとめてください。" +
          "・出力は前置きや説明なしで、純粋にタスク文の行のみとします。";
        const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
          path: "",
          action: "chat",
          prompt,
          fileContent: "",
          history: [],
          model: selectedModel ?? undefined,
          mode: "ask",
          thinking: thinkingMode,
          persona: buildPersonaInstructions()
        });
        const raw = (res.result ?? "").trim();
        const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const tasks = lines
          .map((l) => l.replace(/^[-*\d．\.)\]]+\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 8);
        setBuddySuggestedTasks(tasks);
        if (!tasks.length) {
          setBuddyTasksError("練習タスクをうまく生成できませんでした。もう一度試すか、Buddy に直接簡単なタスクを書いてみてください。");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        setBuddyTasksError(`練習タスクの生成に失敗しました: ${msg}`);
      } finally {
        setBuddyTasksLoading(false);
      }
    },
    [currentWatcher?.id, currentSession?.name, selectedModel, thinkingMode]
  );

  // Buddy AI の学習状態を取得
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await api.getAiBuddyState();
        if (!cancelled) setBuddyState(state);
      } catch {
        if (!cancelled) setBuddyState(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWatcher?.id, currentSession?.name]);

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
    { id: "ask", label: "Ask", title: "シンプルな質問応答" },
    { id: "multi", label: "Multi", title: "複数モデルでディベートして結論を出す" }
  ];

  const thinkingOptions: { id: ThinkingMode; label: string; title: string }[] = [
    { id: "quick", label: "Quick", title: "Quick（速く・浅く）" },
    { id: "balanced", label: "Balanced", title: "Balanced（標準）" },
    { id: "deep", label: "Deep", title: "Deep（じっくり推論）" }
  ];

  const currentChatModeMeta = chatModeOptions.find((o) => o.id === chatMode);
  const currentThinkingMeta = thinkingOptions.find((o) => o.id === thinkingMode);

  // 推奨モデル（UI 上で "Recommended" バッジを付ける対象）は、backend が VRAM に応じて返す recommended を使用

  const buildModelForPayload = () => {
    if (selectedModel === AUTO_MODEL) {
      // Auto 選択時:
      // - ハイブリッドルーティング有効: model は送らず backend 側の router に任せる
      // - 無効: フロント側で選ばれた autoResolved を model として送る
      if (preferences.aiHybridRouting) {
        return undefined;
      }
      return autoResolved ?? undefined;
    }
    return selectedModel ?? undefined;
  };

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
        model: buildModelForPayload(),
        mode: chatMode,
        thinking: thinkingMode,
        persona: buildPersonaInstructions(),
        hybridRouting: preferences.aiHybridRouting || undefined
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
  const suggestedModels = aiModels.suggested ?? [];
  const installedModels = aiModels.installed ?? [];
  const allModelsOrdered = Array.from(new Set([...suggestedModels, ...installedModels]));
  const modelOptions = [
    ...(selectedModel &&
    selectedModel !== AUTO_MODEL &&
    !allModelsOrdered.includes(selectedModel)
      ? [selectedModel]
      : []),
    ...allModelsOrdered
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
              className={`editor-tab${tab === "buddy" ? " active" : ""}`}
              onClick={() => setTab("buddy")}
            >
              Buddy
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
            <div className="ai-settings-section">
              <label className="ai-settings-label">モデルのハイブリッド運用</label>
              <p className="ai-settings-hint">
                Auto 選択時に、タスク内容と VRAM に応じて Qwen / DeepSeek / Llama / Mistral を自動で切り替えるかどうかを指定します。
              </p>
              <label className="ai-settings-toggle">
                <input
                  type="checkbox"
                  checked={preferences.aiHybridRouting}
                  onChange={(e) => updatePreferences({ aiHybridRouting: e.target.checked })}
                />
                <span>ハイブリッドルーティングを有効にする（Auto 時に最適なモデルを自動選択）</span>
              </label>
            </div>
            <div className="ai-settings-section ai-settings-advanced">
              <button
                type="button"
                className="ai-settings-advanced-toggle"
                onClick={() => setShowAdvancedPersona((v) => !v)}
              >
                <span>詳細な性格設定</span>
                <span className="ai-settings-advanced-chevron">{showAdvancedPersona ? "▾" : "▸"}</span>
              </button>
              {showAdvancedPersona && (
                <div className="ai-settings-advanced-body">
                  <div className="ai-settings-subsection">
                    <label className="ai-settings-label">実行スタイル</label>
                    <p className="ai-settings-hint">どれくらい慎重 / 積極的にコード変更やコマンド実行を提案するか。</p>
                    <select
                      className="ai-settings-select"
                      value={preferences.aiExecutionStyle}
                      onChange={(e) => updatePreferences({ aiExecutionStyle: e.target.value as any })}
                    >
                      <option value="normal">標準</option>
                      <option value="careful">慎重に（小さなステップで）</option>
                      <option value="bold">積極的に（大きめの提案も含める）</option>
                    </select>
                  </div>
                  <div className="ai-settings-subsection">
                    <label className="ai-settings-label">質問スタイル</label>
                    <p className="ai-settings-hint">どの程度、確認質問をはさむかの傾向です。</p>
                    <select
                      className="ai-settings-select"
                      value={preferences.aiQuestioningStyle}
                      onChange={(e) => updatePreferences({ aiQuestioningStyle: e.target.value as any })}
                    >
                      <option value="auto">自動（ケースバイケース）</option>
                      <option value="proactive">積極的に質問してから進める</option>
                      <option value="minimal">あまり質問せず、なるべく推測で進める</option>
                    </select>
                  </div>
                  <div className="ai-settings-subsection">
                    <label className="ai-settings-label">説明スタイル</label>
                    <p className="ai-settings-hint">回答の説明をどのくらいステップバイステップにするか。</p>
                    <select
                      className="ai-settings-select"
                      value={preferences.aiExplainStyle}
                      onChange={(e) => updatePreferences({ aiExplainStyle: e.target.value as any })}
                    >
                      <option value="auto">自動（内容に応じて調整）</option>
                      <option value="high_level">なるべく要点だけ・高い粒度で</option>
                      <option value="step_by_step">ステップを追いながら丁寧に解説</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
            <div className="ai-settings-section">
              <label className="ai-settings-label">Buddy Monitor</label>
              <p className="ai-settings-hint">
                Buddy AI がこれまでのフィードバックから学習した傾向を表示します（簡易統計）。
              </p>
              {!buddyState || !buddyState.stats || buddyState.stats.total_feedback === 0 ? (
                <div className="ai-chat-inline-note">まだ十分なフィードバックがありません。</div>
              ) : (
                <div className="ai-buddy-monitor">
                  <div className="ai-buddy-summary">
                    <span>総フィードバック数: {buddyState.stats.total_feedback}</span>
                  </div>
                  <div className="ai-buddy-tasks">
                    {Object.entries(buddyState.stats.per_task).map(([task, s]) => (
                      <div key={task} className="ai-buddy-task-row">
                        <div className="ai-buddy-task-header">
                          <span className="ai-buddy-task-name">{task}</span>
                          <span className="ai-buddy-task-count">
                            {s.good}/{s.total} good
                          </span>
                        </div>
                        <div className="ai-buddy-task-bar">
                          <div
                            className="ai-buddy-task-bar-good"
                            style={{ width: s.total > 0 ? `${(s.good / s.total) * 100}%` : "0%" }}
                          />
                        </div>
                        {s.best_mode && s.best_thinking && (
                          <div className="ai-buddy-task-best">
                            推奨: {s.best_mode} / {s.best_thinking}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {tab === "buddy" && (
          <div className="ai-buddy-tab">
            <div className="ai-settings-section">
              <label className="ai-settings-label">Buddy Training</label>
              <p className="ai-settings-hint">
                Buddy に簡単なタスクを出して練習させるモードです。良い / 悪い回答にはフィードバックを付けてください。
              </p>
              <label className="ai-settings-toggle">
                <input
                  type="checkbox"
                  checked={buddyAllowCommands}
                  onChange={(e) => setBuddyAllowCommands(e.target.checked)}
                />
                <span>Buddy にコマンド実行を許可（Agent モード）</span>
              </label>
              <p className="ai-settings-hint">
                有効にすると、この Buddy チャットでも Agent と同様にターミナルでコマンドを実行して調査します。
              </p>
              <div className="ai-buddy-presets">
                <button
                  type="button"
                  className="icon-button ai-mini-icon-btn"
                  onClick={() =>
                    setBuddyInput(
                      "次のエラーログを読み、原因の候補を2〜3個、箇条書きで挙げてください。さらに、次に確認すべきポイントも1つ提案してください。"
                    )
                  }
                  title="ログ解析の練習"
                >
                  L
                </button>
                <button
                  type="button"
                  className="icon-button ai-mini-icon-btn"
                  onClick={() =>
                    setBuddyInput(
                      "次の関数を読み、より読みやすくリファクタしてください。変更点の要約も短く添えてください。"
                    )
                  }
                  title="リファクタの練習"
                >
                  R
                </button>
                <button
                  type="button"
                  className="icon-button ai-mini-icon-btn"
                  onClick={() => void generateBuddyTasks()}
                  disabled={buddyTasksLoading || !currentWatcher || !currentSession}
                  title="Buddy 向け練習タスクを自動生成"
                >
                  ☆
                </button>
              </div>
              {buddyTasksLoading && (
                <p className="ai-settings-hint">練習タスクを生成中です...</p>
              )}
              {buddyTasksError && (
                <p className="ai-settings-hint ai-buddy-error">{buddyTasksError}</p>
              )}
              {buddySuggestedTasks.length > 0 && (
                <div className="ai-buddy-training-tasks">
                  {buddySuggestedTasks.map((t, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="ai-buddy-task-chip"
                      onClick={() => {
                        setBuddyInput(t);
                        if (!buddyLoading && currentWatcher && currentSession) {
                          void sendBuddy(t);
                        }
                      }}
                      title={t}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="ai-buddy-messages">
              {buddyMessages.map((m, i) => {
                const segs = splitMarkdownCodeFences(m.text);
                return (
                  <div key={i} className={`ai-chat-msg ai-chat-msg-${m.role}`}>
                    <span className="ai-chat-msg-role">{m.role === "user" ? "You" : "Buddy"}</span>
                    {m.role === "assistant" && (
                      <div className="ai-chat-feedback-buttons">
                        <button
                          type="button"
                          className={`icon-button ai-mini-icon-btn ai-chat-feedback-btn${
                            m.feedback === "good" ? " is-active" : ""
                          }`}
                          disabled={!!m.feedback}
                          onClick={() => {
                            if (m.feedback) return;
                            void (async () => {
                              await sendFeedback(m, "good");
                              setBuddyMessages((prev) => {
                                const next = [...prev];
                                if (!next[i]) return prev;
                                if (next[i].feedback) return prev;
                                next[i] = { ...next[i], feedback: "good" };
                                return next;
                              });
                            })();
                          }}
                          title="この回答は役に立った"
                          aria-label="この回答は役に立った"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                            <path
                              d="M9 12l2 2 4-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={`icon-button ai-mini-icon-btn ai-chat-feedback-btn${
                            m.feedback === "bad" ? " is-active" : ""
                          }`}
                          disabled={!!m.feedback}
                          onClick={() => {
                            if (m.feedback) return;
                            void (async () => {
                              await sendFeedback(m, "bad");
                              setBuddyMessages((prev) => {
                                const next = [...prev];
                                if (!next[i]) return prev;
                                if (next[i].feedback) return prev;
                                next[i] = { ...next[i], feedback: "bad" };
                                return next;
                              });
                            })();
                          }}
                          title="この回答はいまいち"
                          aria-label="この回答はいまいち"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M9 9l6 6M15 9l-6 6"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </div>
                    )}
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
                      return (
                        <pre key={idx} className="ai-chat-code">
                          <code
                            className={`language-${lang}`}
                            dangerouslySetInnerHTML={{ __html: highlighted }}
                          />
                        </pre>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <form
              className="ai-chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (buddyInput.trim() && !buddyLoading) void sendBuddy(buddyInput);
              }}
            >
              <div className="ai-chat-composer">
                <textarea
                  className="ai-chat-input"
                  placeholder="Buddy に練習タスクを出してみましょう"
                  value={buddyInput}
                  onChange={(e) => setBuddyInput(e.target.value)}
                  disabled={buddyLoading || !currentWatcher || !currentSession}
                />
                <div className="ai-chat-composer-right">
                  <button
                    type="submit"
                    className="ai-chat-send-btn"
                    disabled={!currentWatcher || !currentSession || (!buddyLoading && !buddyInput.trim())}
                    title={buddyLoading ? "停止" : "送信"}
                    aria-label={buddyLoading ? "停止" : "送信"}
                  >
                    {buddyLoading ? (
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
            </form>
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
          <button
            type="button"
            className={`ai-chat-subtab${chatView === "debate" ? " active" : ""}`}
            onClick={() => setChatView("debate")}
          >
            Debate
          </button>
        </div>
        <div className="ai-chat-messages">
          {chatView === "messages" && pendingCommand && pendingCommand.chatId === activeChatId && (
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
            const isEditingUser = m.role === "user" && editingMessageIndex === i;
            if (isEditingUser) {
              return (
                <div key={i} className="ai-chat-msg ai-chat-msg-user">
                  <span className="ai-chat-msg-role">You</span>
                  <div className="ai-chat-edit-message">
                    <textarea
                      className="ai-chat-edit-textarea"
                      value={editingMessageText}
                      onChange={(e) => setEditingMessageText(e.target.value)}
                      rows={4}
                    />
                    <div className="ai-chat-edit-actions">
                      <button
                        type="button"
                        className="icon-button ai-mini-icon-btn"
                        onClick={() => {
                          if (!editingMessageText.trim()) return;
                          void send(editingMessageText.trim(), { historyBeforeIndex: i });
                          setEditingMessageIndex(null);
                          setEditingMessageText("");
                        }}
                        disabled={loading}
                        title="編集内容を送信"
                        aria-label="編集内容を送信"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 18L12 5l7 13z" fill="currentColor" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="icon-button ai-mini-icon-btn"
                        onClick={() => {
                          setEditingMessageIndex(null);
                          setEditingMessageText("");
                        }}
                        title="編集をキャンセル"
                        aria-label="編集をキャンセル"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            }
            const segs = splitMarkdownCodeFences(m.text);
            return (
              <div key={i} className={`ai-chat-msg ai-chat-msg-${m.role}`}>
                <span className="ai-chat-msg-role">{m.role === "user" ? "You" : "AI"}</span>
                {m.role === "user" && (
                  <button
                    type="button"
                    className="ai-chat-msg-edit-btn"
                    onClick={() => {
                      setEditingMessageIndex(i);
                      setEditingMessageText(m.text);
                    }}
                    title="メッセージを編集して再送信（それ以降の会話はリセット）"
                    aria-label="メッセージを編集"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M4 20h4l10-10-4-4L4 16v4z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {m.role === "assistant" && (
                  <div className="ai-chat-feedback-buttons">
                    <button
                      type="button"
                      className={`icon-button ai-mini-icon-btn ai-chat-feedback-btn${
                        m.feedback === "good" ? " is-active" : ""
                      }`}
                      disabled={!!m.feedback}
                      onClick={() => {
                        if (m.feedback) return;
                        void (async () => {
                          await sendFeedback(m, "good");
                          setChats((prev) => {
                            const mid = activeChatId;
                            const chat = prev[mid];
                            if (!chat) return prev;
                            const msgs = [...chat.messages];
                            if (!msgs[i]) return prev;
                            if (msgs[i].feedback) return prev;
                            msgs[i] = { ...msgs[i], feedback: "good" };
                            return { ...prev, [mid]: { ...chat, messages: msgs } };
                          });
                        })();
                      }}
                      title="この回答は役に立った"
                      aria-label="この回答は役に立った"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                        <path
                          d="M9 12l2 2 4-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`icon-button ai-mini-icon-btn ai-chat-feedback-btn${
                        m.feedback === "bad" ? " is-active" : ""
                      }`}
                      disabled={!!m.feedback}
                      onClick={() => {
                        if (m.feedback) return;
                        void (async () => {
                          await sendFeedback(m, "bad");
                          setChats((prev) => {
                            const mid = activeChatId;
                            const chat = prev[mid];
                            if (!chat) return prev;
                            const msgs = [...chat.messages];
                            if (!msgs[i]) return prev;
                            if (msgs[i].feedback) return prev;
                            msgs[i] = { ...msgs[i], feedback: "bad" };
                            return { ...prev, [mid]: { ...chat, messages: msgs } };
                          });
                        })();
                      }}
                      title="この回答はいまいち"
                      aria-label="この回答はいまいち"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M9 9l6 6M15 9l-6 6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                )}
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
          {chatView === "debate" && (
            <div className="ai-chat-logs">
              {(!currentDebates || currentDebates.length === 0) && (
                <div className="ai-chat-inline-note">
                  まだマルチモデル・ディベートの履歴がありません（Chat モードを Multi にして送信すると記録されます）。
                </div>
              )}
              {currentDebates.map((debate) => (
                <div key={debate.id} className="ai-chat-log-entry">
                  <div className="ai-chat-log-header">
                    <span className="ai-chat-log-label">
                      {debate.title || "Multi‑model debate"}
                    </span>
                    <span className="ai-chat-log-label">
                      {debate.models.join(" , ")}
                    </span>
                    {chatMode === "multi" && (
                      <button
                        type="button"
                        className="icon-button ai-mini-icon-btn"
                        onClick={() => rerunMultiDebate(debate)}
                        title="もう1サイクル実行"
                        aria-label="もう1サイクル実行"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="1 4 1 10 7 10" />
                          <polyline points="23 20 23 14 17 14" />
                          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10" />
                          <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {debate.turns.map((t, idx) => (
                    <div
                      key={idx}
                      className="ai-chat-msg"
                      style={{
                        paddingTop: 2,
                        paddingBottom: 2,
                        borderTop: idx === 0 ? "none" : "1px solid var(--color-pane-border)",
                        marginTop: idx === 0 ? 0 : 4
                      }}
                    >
                      <span className="ai-chat-msg-role">
                        Round {t.round} · {t.speaker} ({t.model})
                      </span>
                      <div className="ai-chat-msg-text">
                        {t.content}
                      </div>
                    </div>
                  ))}
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
                      {chatMode === "multi" && (
                        <svg viewBox="0 0 24 24">
                          {/* three overlapping bubbles to express multi-agent */}
                          <path d="M4 7h9a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H9l-3 3v-3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
                          <path d="M11 4h7a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1" />
                          <path d="M13 13h5a2 2 0 0 1 2 2v1.5" />
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
                        {modelOptions.map((m) => {
                          const isSelected = selectedModel === m;
                          const isInstalled = installedModels.includes(m);
                          const isRecommended = (aiModels.recommended ?? []).includes(m);
                          const titleParts = [m];
                          if (isRecommended) titleParts.push("recommended");
                          if (!isInstalled) titleParts.push("not installed");
                          const titleText = titleParts.join(" · ");
                          return (
                            <button
                              key={m}
                              type="button"
                              className={`ai-chat-model-option${isSelected ? " active" : ""}`}
                              onClick={() => void selectModel(m)}
                              disabled={ensuringModel !== null}
                              title={titleText}
                            >
                              <span className="ai-chat-model-option-check" aria-hidden>
                                {isSelected ? "✓" : ""}
                              </span>
                              <span className="ai-chat-model-option-label">
                                <span className="ai-chat-model-name">{m}</span>
                                <span className="ai-chat-model-tags">
                                  {isRecommended && (
                                    <span className="ai-chat-model-tag ai-chat-model-tag-suggest">Recommended</span>
                                  )}
                                  {!isInstalled && (
                                    <span className="ai-chat-model-tag ai-chat-model-tag-uninstalled">Pull</span>
                                  )}
                                </span>
                              </span>
                            </button>
                          );
                        })}
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
