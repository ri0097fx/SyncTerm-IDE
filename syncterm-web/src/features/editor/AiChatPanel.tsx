import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { useActiveEditor } from "./ActiveEditorContext";
import { api } from "../../lib/api";

type Message = { role: "user" | "assistant"; text: string };
type PendingCommand = { command: string };

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
  chats: Record<string, { name?: string; messages: Message[] }>;
  selectedModel?: string;
  chatMode?: ChatMode;
  thinkingMode?: ThinkingMode;
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
      const rawChats = (parsed.chats ?? {}) as Record<string, { name?: string; messages?: unknown }>;
      const chats: Record<string, { name?: string; messages: Message[] }> = {};
      for (const id of ids) {
        const c = rawChats[id];
        chats[id] = { name: c?.name, messages: Array.isArray(c?.messages) ? c.messages : [] };
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
  const { updatePreferences } = usePreferences();
  const { activeEditor, applyToSelection, appendAtCursor } = useActiveEditor();
  const [tab, setTab] = useState<"chat" | "assist">("chat");
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const chatsRef = useRef(chats);
  const activeChatIdRef = useRef(activeChatId);

  const currentMessages = Array.isArray(chats[activeChatId]?.messages) ? chats[activeChatId].messages : [];
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => { chatsRef.current = chats; }, [chats]);
  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);

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

  const selectModel = useCallback(async (model: string) => {
    const ok = await ensureModel(model);
    if (ok) setSelectedModel(model);
    setModelDropdownOpen(false);
  }, [ensureModel]);

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
        const history = (chats[mid]?.messages ?? []).map((m) => ({ role: m.role, content: m.text }));
        const res = await api.runAiAssist(currentWatcher.id, currentSession.name, {
          path: "",
          action: "chat",
          prompt: userMessage,
          fileContent: "",
          history,
          model: selectedModel ?? undefined,
          mode: chatMode,
          ...(chatMode === "agent" && {
            editorPath: activeEditor.path ?? undefined,
            editorSelectedText: activeEditor.selectedText ?? undefined,
            editorContent: activeEditor.content ?? undefined
          }),
          thinking: thinkingMode
        });
        const reply = (res.result ?? "").trim() || "(no response)";
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
        const errMsg = e instanceof Error ? e.message : "Request failed";
        setChats((prev) => ({
          ...prev,
          [mid]: { ...prev[mid], messages: [...(prev[mid]?.messages ?? []), { role: "assistant", text: `Error: ${errMsg}` }] }
        }));
        setTimeout(scrollToBottom, 50);
      } finally {
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
        model: selectedModel ?? undefined,
        mode: chatMode,
        ...(chatMode === "agent" && {
          editorPath: activeEditor.path ?? undefined,
          editorSelectedText: activeEditor.selectedText ?? undefined,
          editorContent: activeEditor.content ?? undefined
        }),
        thinking: thinkingMode
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
        model: selectedModel ?? undefined,
        mode: chatMode,
        thinking: thinkingMode
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

  const thinkingOptions: { id: ThinkingMode; title: string }[] = [
    { id: "quick", title: "Quick（速く・浅く）" },
    { id: "balanced", title: "Balanced（標準）" },
    { id: "deep", title: "Deep（じっくり推論）" }
  ];

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
        model: selectedModel ?? undefined,
        mode: chatMode,
        thinking: thinkingMode
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
  const displayModel = selectedModel ?? aiModels.suggested[0] ?? "";
  const modelOptions = [
    ...(selectedModel && !aiModels.suggested.includes(selectedModel) ? [selectedModel] : []),
    ...aiModels.suggested
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
          </div>
        </div>
        <button type="button" className="icon-button" onClick={close} title="閉じる">
          ×
        </button>
      </div>
      <div className="ai-chat-body">
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
        <div className="ai-chat-messages">
          {pendingCommand && (
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
          {currentMessages.map((m, i) => {
            const segs = splitMarkdownCodeFences(m.text);
            return (
              <div key={i} className={`ai-chat-msg ai-chat-msg-${m.role}`}>
                <span className="ai-chat-msg-role">{m.role === "user" ? "You" : "AI"}</span>
                {segs.map((s, idx) => {
                  if (s.kind === "text") {
                    const t = s.text.trimEnd();
                    if (!t) return null;
                    return (
                      <pre key={idx} className="ai-chat-msg-text">{t}</pre>
                    );
                  }
                  if (m.role !== "assistant") {
                    return (
                      <pre key={idx} className="ai-chat-code">{s.code}</pre>
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
                      <pre className="ai-chat-code">{s.code}</pre>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {loading && (
            <div className="ai-chat-msg ai-chat-msg-assistant">
              <span className="ai-chat-msg-role">AI</span>
              <span className="ai-chat-msg-text">...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="ai-chat-mode-row">
          {chatModeOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`ai-chat-mode-btn${chatMode === opt.id ? " active" : ""}`}
              onClick={() => setChatMode(opt.id)}
              title={opt.title}
            >
              <span className="ai-chat-mode-icon" aria-hidden>
                {opt.id === "agent" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="6" r="2.5" /><circle cx="7" cy="16" r="2.5" /><circle cx="17" cy="16" r="2.5" />
                    <path d="M12 8.5v2M9.2 14.2l2.1-2.2M14.8 14.2l-2.1-2.2" />
                  </svg>
                )}
                {opt.id === "plan" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
                  </svg>
                )}
                {opt.id === "debug" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5l-1.5 2M12 5l1.5 2" />
                    <path d="M8 8c0-2 1.5-3 4-3s4 1 4 3v6c0 2-1.5 3-4 3s-4-1-4-3V8z" />
                    <path d="M7 14l-2 2M17 14l2 2M10 19l1 2M14 19l-1 2" />
                  </svg>
                )}
                {opt.id === "ask" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                  </svg>
                )}
              </span>
              <span className="ai-chat-mode-label">{opt.label}</span>
            </button>
          ))}
        </div>
        <div className="ai-chat-mode-row" style={{ marginTop: "0.2rem" }}>
          {thinkingOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`ai-chat-mode-btn${thinkingMode === opt.id ? " active" : ""}`}
              onClick={() => setThinkingMode(opt.id)}
              title={opt.title}
              aria-label={opt.title}
            >
              <span className="ai-thinking-icon" aria-hidden>
                {opt.id === "quick" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 12h12" />
                  </svg>
                )}
                {opt.id === "balanced" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
                {opt.id === "deep" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12h16" />
                    <path d="M8 8c2-3 6-3 8 0" />
                    <path d="M8 16c2 3 6 3 8 0" />
                  </svg>
                )}
              </span>
              <span className="sr-only">{opt.title}</span>
            </button>
          ))}
        </div>
        <form className="ai-chat-form" onSubmit={handleSubmit}>
          <div className="ai-chat-form-row">
            <div className="ai-chat-form-left" ref={modelDropdownRef}>
              <div className="ai-chat-model-dropdown">
                <button
                  type="button"
                  className="icon-button ai-model-btn"
                  onClick={() => setModelDropdownOpen((o) => !o)}
                  title={displayModel || "モデルを選択"}
                  disabled={noSession}
                >
                  <span className="ai-model-icon" aria-hidden>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2L9 8H3l5 4-2 6 6-4 6 4-2-6 5-4H15L12 2z" />
                    </svg>
                  </span>
                </button>
                {modelDropdownOpen && (
                  <div className="ai-chat-model-menu">
                    {installProgress && (
                      <div className="ai-chat-model-ensuring">
                        {installProgress.model} … {installProgress.percent != null ? `${installProgress.percent}%` : installProgress.status}
                      </div>
                    )}
                    {modelOptions.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`ai-chat-model-option${selectedModel === m ? " active" : ""}`}
                        onClick={() => void selectModel(m)}
                        disabled={ensuringModel !== null}
                        title={m}
                      >
                        <span className="ai-chat-model-option-label">{m} {aiModels.installed.includes(m) ? "" : " (未インストール)"}</span>
                      </button>
                    ))}
                    {modelOptions.length === 0 && !ensuringModel && (
                      <div className="ai-chat-model-option muted">利用可能なモデルがありません</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <input
              type="text"
              className="ai-chat-input"
              placeholder={noSession ? "Watcher / Session を選択してください" : "メッセージを入力"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={noSession || loading}
            />
            <button type="submit" className="primary-button ai-chat-send-btn" disabled={noSession || loading || !input.trim()}>
              送信
            </button>
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
            <div className="ai-chat-mode-row" style={{ marginBottom: "0.25rem" }}>
              {chatModeOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ai-chat-mode-btn${chatMode === opt.id ? " active" : ""}`}
                  onClick={() => setChatMode(opt.id)}
                  title={opt.title}
                >
                  <span className="ai-chat-mode-icon" aria-hidden>
                    {opt.id === "agent" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="6" r="2.5" /><circle cx="7" cy="16" r="2.5" /><circle cx="17" cy="16" r="2.5" />
                        <path d="M12 8.5v2M9.2 14.2l2.1-2.2M14.8 14.2l-2.1-2.2" />
                      </svg>
                    )}
                    {opt.id === "plan" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
                      </svg>
                    )}
                    {opt.id === "debug" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5l-1.5 2M12 5l1.5 2" />
                        <path d="M8 8c0-2 1.5-3 4-3s4 1 4 3v6c0 2-1.5 3-4 3s-4-1-4-3V8z" />
                        <path d="M7 14l-2 2M17 14l2 2M10 19l1 2M14 19l-1 2" />
                      </svg>
                    )}
                    {opt.id === "ask" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                      </svg>
                    )}
                  </span>
                  <span className="ai-chat-mode-label">{opt.label}</span>
                </button>
              ))}
            </div>
            <div className="ai-chat-mode-row" style={{ marginBottom: "0.5rem" }}>
              {thinkingOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ai-chat-mode-btn${thinkingMode === opt.id ? " active" : ""}`}
                  onClick={() => setThinkingMode(opt.id)}
                  title={opt.title}
                  aria-label={opt.title}
                >
                  <span className="ai-thinking-icon" aria-hidden>
                    {opt.id === "quick" && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 12h12" />
                      </svg>
                    )}
                    {opt.id === "balanced" && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                    {opt.id === "deep" && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 12h16" />
                        <path d="M8 8c2-3 6-3 8 0" />
                        <path d="M8 16c2 3 6 3 8 0" />
                      </svg>
                    )}
                  </span>
                  <span className="sr-only">{opt.title}</span>
                </button>
              ))}
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
