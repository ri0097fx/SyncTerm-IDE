import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionBar } from "../../features/session/SessionBar";
import { FileTreePanel } from "../../features/file-tree/FileTreePanel";
import { EditorPanel } from "../../features/editor/EditorPanel";
import { ImagePreviewPanel } from "../../features/editor/ImagePreviewPanel";
import { TerminalPanel } from "../../features/terminal/TerminalPanel";
import { GpuStatusPanel } from "../../features/terminal/GpuStatusPanel";
import { AiChatPanel } from "../../features/editor/AiChatPanel";
import { ActiveEditorProvider } from "../../features/editor/ActiveEditorContext";
import { ExtensionPanelHost } from "../../features/extensions/ExtensionPanelHost";
import { useExtensionRuntime } from "../../features/extensions/ExtensionRuntimeContext";
import { isImagePath } from "../../lib/fileType";
import { usePreferences } from "../../features/preferences/PreferencesContext";

const DOCK_STORAGE_KEY = "syncterm.dockedExtensions";
function loadDockedSet(): Set<string> {
  try { const raw = localStorage.getItem(DOCK_STORAGE_KEY); return raw ? new Set(JSON.parse(raw) as string[]) : new Set(); } catch { return new Set(); }
}
function saveDockedSet(s: Set<string>) {
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

export const MainLayout: React.FC = () => {
  const { preferences } = usePreferences();
  const { panels: runtimePanels, activePanelId } = useExtensionRuntime();
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [openEditorPaths, setOpenEditorPaths] = useState<string[]>([]);
  const [editorPathReopenTick, setEditorPathReopenTick] = useState<Record<string, number>>({});
  const openEditorPathsRef = useRef<Set<string>>(new Set());
  const [activeImagePath, setActiveImagePath] = useState<string | null>(null);
  const [openImagePaths, setOpenImagePaths] = useState<string[]>([]);
  const [leftPaneWidth, setLeftPaneWidth] = useState(320);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(230);
  const [previewPaneWidth, setPreviewPaneWidth] = useState(360);
  const dragModeRef = useRef<"vertical" | "horizontal" | "preview" | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  const [dockedToEditor, setDockedToEditor] = useState<Set<string>>(loadDockedSet);
  const [activeDockedPanelId, setActiveDockedPanelId] = useState<string | null>(null);

  const toggleDock = useCallback((panelId: string) => {
    setDockedToEditor((prev) => {
      const next = new Set(prev);
      if (next.has(panelId)) {
        next.delete(panelId);
        if (activeDockedPanelId === panelId) setActiveDockedPanelId(null);
      } else {
        next.add(panelId);
        setActiveDockedPanelId(panelId);
      }
      saveDockedSet(next);
      return next;
    });
  }, [activeDockedPanelId]);

  const editorDockedPanels = useMemo(() => runtimePanels.filter((p) => dockedToEditor.has(p.id)), [runtimePanels, dockedToEditor]);
  const previewOnlyPanels = useMemo(() => runtimePanels.filter((p) => !dockedToEditor.has(p.id)), [runtimePanels, dockedToEditor]);

  const showImagePreviewPane = openImagePaths.length > 0;
  const showGpuPanel = preferences.showGpuPanel;
  const showAiChatPanel = preferences.showAiChatPanel;
  const showExtensionPanel = previewOnlyPanels.length > 0;
  const showPreviewPane = showImagePreviewPane || showGpuPanel || showAiChatPanel || showExtensionPanel;
  const showPreviewTabs =
    [showImagePreviewPane, showGpuPanel, showAiChatPanel, showExtensionPanel].filter(Boolean).length >= 2 ||
    previewOnlyPanels.length >= 2;
  const [previewTab, setPreviewTab] = useState<string>("image");

  useEffect(() => {
    if (activePanelId && !dockedToEditor.has(activePanelId)) {
      setPreviewTab(`ext:${activePanelId}`);
    }
  }, [activePanelId, dockedToEditor]);

  useEffect(() => {
    const available: string[] = [];
    if (showImagePreviewPane) available.push("image");
    if (showGpuPanel) available.push("gpu");
    if (showAiChatPanel) available.push("ai");
    for (const p of previewOnlyPanels) available.push(`ext:${p.id}`);
    if (available.length === 0) return;
    if (!available.includes(previewTab)) {
      setPreviewTab(available[0]);
    }
  }, [previewTab, previewOnlyPanels, showAiChatPanel, showGpuPanel, showImagePreviewPane]);

  useEffect(() => {
    if (activeDockedPanelId && !editorDockedPanels.some((p) => p.id === activeDockedPanelId)) {
      setActiveDockedPanelId(null);
    }
  }, [activeDockedPanelId, editorDockedPanels]);

  useEffect(() => {
    openEditorPathsRef.current = new Set(openEditorPaths);
  }, [openEditorPaths]);

  const handleOpenFile = (path: string) => {
    if (isImagePath(path)) {
      setOpenImagePaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setActiveImagePath(path);
    } else {
      if (openEditorPathsRef.current.has(path)) {
        setEditorPathReopenTick((t) => ({ ...t, [path]: (t[path] ?? 0) + 1 }));
      } else {
        openEditorPathsRef.current.add(path);
        setOpenEditorPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      }
      setActiveEditorPath(path);
    }
  };

  const handleSelectEditorFile = (path: string) => {
    setActiveEditorPath(path);
  };

  const handleSelectImageFile = (path: string) => {
    setActiveImagePath(path);
  };

  const handleCloseEditorFile = (path: string) => {
    openEditorPathsRef.current.delete(path);
    setEditorPathReopenTick((t) => {
      if (!(path in t)) return t;
      const { [path]: _, ...rest } = t;
      return rest;
    });
    setOpenEditorPaths((prev) => {
      const idx = prev.indexOf(path);
      if (idx < 0) return prev;
      const next = prev.filter((p) => p !== path);
      if (activeEditorPath === path) {
        setActiveEditorPath(next.length === 0 ? null : next[Math.max(0, idx - 1)] ?? next[0]);
      }
      return next;
    });
  };

  const handleCloseImageFile = (path: string) => {
    setOpenImagePaths((prev) => {
      const idx = prev.indexOf(path);
      if (idx < 0) return prev;
      const next = prev.filter((p) => p !== path);
      if (activeImagePath === path) {
        setActiveImagePath(next.length === 0 ? null : next[Math.max(0, idx - 1)] ?? next[0]);
      }
      return next;
    });
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragModeRef.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();

      if (dragModeRef.current === "vertical") {
        const next = e.clientX - rect.left;
        const clamped = Math.max(220, Math.min(rect.width - 320, next));
        setLeftPaneWidth(clamped);
      } else if (dragModeRef.current === "preview") {
        const rightEdge = rect.right;
        const next = rightEdge - e.clientX;
        const clamped = Math.max(260, Math.min(Math.floor(rect.width * 0.7), next));
        setPreviewPaneWidth(clamped);
      } else {
        const nextBottom = rect.bottom - e.clientY;
        const clamped = Math.max(160, Math.min(rect.height - 200, nextBottom));
        setBottomPaneHeight(clamped);
      }
    };

    const onMouseUp = () => {
      dragModeRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="app-shell">
      <SessionBar />
      <div className="app-main" ref={mainRef}>
        <ActiveEditorProvider>
        <div className="app-main-top">
          <div className="app-left-pane" style={{ width: leftPaneWidth }}>
            <FileTreePanel onOpenFile={handleOpenFile} />
          </div>
          <div
            className="splitter splitter-vertical"
            onMouseDown={(e) => {
              e.preventDefault();
              dragModeRef.current = "vertical";
            }}
          />
          <div className="app-right-pane">
            <div className="editor-preview-layout">
              <div className={`editor-main-pane${showPreviewPane ? " with-preview" : ""}`}>
                <EditorPanel
                  filePath={activeEditorPath}
                  openFilePaths={openEditorPaths}
                  treeReopenTick={activeEditorPath ? editorPathReopenTick[activeEditorPath] ?? 0 : 0}
                  onSelectFile={handleSelectEditorFile}
                  onCloseFile={handleCloseEditorFile}
                  dockedPanels={editorDockedPanels}
                  activeDockedPanelId={activeDockedPanelId}
                  onSelectDockedPanel={setActiveDockedPanelId}
                  onToggleDock={toggleDock}
                />
                <div
                  className="splitter splitter-horizontal"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    dragModeRef.current = "horizontal";
                  }}
                />
                <div className="app-bottom-pane" style={{ height: bottomPaneHeight }}>
                  <TerminalPanel />
                </div>
              </div>
              {showPreviewPane && (
                <>
                  <div
                    className="splitter splitter-vertical splitter-preview"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      dragModeRef.current = "preview";
                    }}
                  />
                  <div
                    className="image-preview-pane preview-pane-slot"
                    style={{ width: previewPaneWidth, minWidth: previewPaneWidth, flex: "0 0 auto" }}
                  >
                    {showPreviewTabs ? (
                      <>
                        <div className="editor-tabs image-preview-tabs">
                          {showImagePreviewPane && (
                            <button
                              type="button"
                              className={`editor-tab${previewTab === "image" ? " active" : ""}`}
                              onClick={() => setPreviewTab("image")}
                            >
                              <span className="editor-tab-label">Image</span>
                            </button>
                          )}
                          {showGpuPanel && (
                            <button
                              type="button"
                              className={`editor-tab${previewTab === "gpu" ? " active" : ""}`}
                              onClick={() => setPreviewTab("gpu")}
                            >
                              <span className="editor-tab-label">GPU</span>
                            </button>
                          )}
                          {showAiChatPanel && (
                            <button
                              type="button"
                              className={`editor-tab${previewTab === "ai" ? " active" : ""}`}
                              onClick={() => setPreviewTab("ai")}
                            >
                              <span className="editor-tab-label">AI</span>
                            </button>
                          )}
                          {showExtensionPanel &&
                            previewOnlyPanels.map((panel) => (
                              <button
                                key={panel.id}
                                type="button"
                                className={`editor-tab${previewTab === `ext:${panel.id}` ? " active" : ""}`}
                                onClick={() => setPreviewTab(`ext:${panel.id}`)}
                              >
                                <span className="editor-tab-label">{panel.title}</span>
                              </button>
                            ))}
                        </div>
                        {showImagePreviewPane && (
                          <div
                            style={{
                              display: previewTab === "image" ? "flex" : "none",
                              flex: 1,
                              minHeight: 0,
                              flexDirection: "column"
                            }}
                          >
                            <ImagePreviewPanel
                              filePath={activeImagePath}
                              openImagePaths={openImagePaths}
                              onSelectImage={handleSelectImageFile}
                              onCloseImage={handleCloseImageFile}
                            />
                          </div>
                        )}
                        {showGpuPanel && (
                          <div
                            style={{
                              display: previewTab === "gpu" ? "flex" : "none",
                              flex: 1,
                              minHeight: 0,
                              flexDirection: "column"
                            }}
                          >
                            <GpuStatusPanel />
                          </div>
                        )}
                        {showAiChatPanel && (
                          <div
                            style={{
                              display: previewTab === "ai" ? "flex" : "none",
                              flex: 1,
                              minHeight: 0,
                              flexDirection: "column"
                            }}
                          >
                            <AiChatPanel fallbackEditorPath={activeEditorPath} />
                          </div>
                        )}
                        {showExtensionPanel &&
                          previewOnlyPanels.map((panel) => (
                            <div
                              key={panel.id}
                              style={{
                                display: previewTab === `ext:${panel.id}` ? "flex" : "none",
                                flex: 1,
                                minHeight: 0,
                                flexDirection: "column"
                              }}
                            >
                              <ExtensionPanelHost panelId={panel.id} isDockedToEditor={false} onToggleDock={() => toggleDock(panel.id)} />
                            </div>
                          ))}
                      </>
                    ) : showImagePreviewPane ? (
                      <ImagePreviewPanel
                        filePath={activeImagePath}
                        openImagePaths={openImagePaths}
                        onSelectImage={handleSelectImageFile}
                        onCloseImage={handleCloseImageFile}
                      />
                    ) : showGpuPanel ? (
                      <GpuStatusPanel />
                    ) : showAiChatPanel ? (
                      <AiChatPanel fallbackEditorPath={activeEditorPath} />
                    ) : (
                      <ExtensionPanelHost panelId={activePanelId ?? previewOnlyPanels[0]?.id ?? null} isDockedToEditor={false} onToggleDock={() => { const id = activePanelId ?? previewOnlyPanels[0]?.id; if (id) toggleDock(id); }} />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        </ActiveEditorProvider>
      </div>
    </div>
  );
};

