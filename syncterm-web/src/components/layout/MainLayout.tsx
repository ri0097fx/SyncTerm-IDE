import React, { useEffect, useRef, useState } from "react";
import { SessionBar } from "../../features/session/SessionBar";
import { FileTreePanel } from "../../features/file-tree/FileTreePanel";
import { EditorPanel } from "../../features/editor/EditorPanel";
import { ImagePreviewPanel } from "../../features/editor/ImagePreviewPanel";
import { TerminalPanel } from "../../features/terminal/TerminalPanel";
import { GpuStatusPanel } from "../../features/terminal/GpuStatusPanel";
import { AiChatPanel } from "../../features/editor/AiChatPanel";
import { ActiveEditorProvider } from "../../features/editor/ActiveEditorContext";
import { isImagePath } from "../../lib/fileType";
import { usePreferences } from "../../features/preferences/PreferencesContext";

export const MainLayout: React.FC = () => {
  const { preferences } = usePreferences();
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [openEditorPaths, setOpenEditorPaths] = useState<string[]>([]);
  const [activeImagePath, setActiveImagePath] = useState<string | null>(null);
  const [openImagePaths, setOpenImagePaths] = useState<string[]>([]);
  const [leftPaneWidth, setLeftPaneWidth] = useState(320);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(230);
  const [previewPaneWidth, setPreviewPaneWidth] = useState(360);
  const dragModeRef = useRef<"vertical" | "horizontal" | "preview" | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const showImagePreviewPane = openImagePaths.length > 0;
  const showGpuPanel = preferences.showGpuPanel;
  const showAiChatPanel = preferences.showAiChatPanel;
  const showPreviewPane = showImagePreviewPane || showGpuPanel || showAiChatPanel;
  const [previewTab, setPreviewTab] = useState<"image" | "gpu" | "ai">("image");

  const handleOpenFile = (path: string) => {
    if (isImagePath(path)) {
      setOpenImagePaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setActiveImagePath(path);
    } else {
      setOpenEditorPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
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
                  onSelectFile={handleSelectEditorFile}
                  onCloseFile={handleCloseEditorFile}
                />
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
                  {[showImagePreviewPane, showGpuPanel, showAiChatPanel].filter(Boolean).length >= 2 ? (
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
                      </div>
                      {previewTab === "image" && showImagePreviewPane && (
                        <ImagePreviewPanel
                          filePath={activeImagePath}
                          openImagePaths={openImagePaths}
                          onSelectImage={handleSelectImageFile}
                          onCloseImage={handleCloseImageFile}
                        />
                      )}
                      {previewTab === "gpu" && showGpuPanel && <GpuStatusPanel />}
                      {previewTab === "ai" && showAiChatPanel && <AiChatPanel />}
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
                  ) : (
                    <AiChatPanel />
                  )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
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
        </ActiveEditorProvider>
      </div>
    </div>
  );
};

