import React, { useEffect, useRef, useState } from "react";
import { SessionBar } from "../../features/session/SessionBar";
import { FileTreePanel } from "../../features/file-tree/FileTreePanel";
import { EditorPanel } from "../../features/editor/EditorPanel";
import { ImagePreviewPanel } from "../../features/editor/ImagePreviewPanel";
import { TerminalPanel } from "../../features/terminal/TerminalPanel";
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
  const dragModeRef = useRef<"vertical" | "horizontal" | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const showImagePreviewPane = openImagePaths.length > 0;

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
              <div className={`editor-main-pane${showImagePreviewPane ? " with-preview" : ""}`}>
                <EditorPanel
                  filePath={activeEditorPath}
                  openFilePaths={openEditorPaths}
                  onSelectFile={handleSelectEditorFile}
                  onCloseFile={handleCloseEditorFile}
                />
              </div>
              {showImagePreviewPane && (
                <div className="image-preview-pane">
                  <ImagePreviewPanel
                    filePath={activeImagePath}
                    openImagePaths={openImagePaths}
                    onSelectImage={handleSelectImageFile}
                    onCloseImage={handleCloseImageFile}
                  />
                </div>
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
      </div>
    </div>
  );
};

