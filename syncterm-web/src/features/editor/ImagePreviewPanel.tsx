import React, { useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import { api } from "../../lib/api";
import { isImagePath } from "../../lib/fileType";

interface ImagePreviewPanelProps {
  filePath: string | null;
  openImagePaths: string[];
  onSelectImage: (path: string) => void;
  onCloseImage: (path: string) => void;
}

export const ImagePreviewPanel: React.FC<ImagePreviewPanelProps> = ({
  filePath,
  openImagePaths,
  onSelectImage,
  onCloseImage
}) => {
  const { currentWatcher, currentSession } = useSession();
  const [imageFailed, setImageFailed] = useState(false);
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null);

  const isImageFile = !!filePath && isImagePath(filePath);

  useEffect(() => {
    setImageFailed(false);
    setImageObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (!filePath || !isImageFile || !currentWatcher || !currentSession) return;
    let cancelled = false;
    api
      .getRawFileBlob(currentWatcher.id, currentSession.name, filePath)
      .then((blob) => {
        if (!cancelled) {
          setImageObjectUrl(URL.createObjectURL(blob));
        }
      })
      .catch(() => {
        if (!cancelled) setImageFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, isImageFile, currentWatcher?.id, currentSession?.name]);

  useEffect(() => () => {
    imageObjectUrl && URL.revokeObjectURL(imageObjectUrl);
  }, [imageObjectUrl]);

  return (
    <div className="pane pane-right">
      <div className="pane-header">
        <span className="pane-title">Image Preview</span>
      </div>
      {openImagePaths.length > 0 && (
        <div className="editor-tabs image-preview-tabs">
          {openImagePaths.map((path) => {
            const isActive = path === filePath;
            const name = path.split("/").filter(Boolean).pop() ?? path;
            return (
              <button
                key={path}
                type="button"
                className={`editor-tab${isActive ? " active" : ""}`}
                onClick={() => onSelectImage(path)}
                title={path}
              >
                <span className="editor-tab-label">{name}</span>
                <span
                  className="editor-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseImage(path);
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
      <div className="pane-body editor-body">
        {!isImageFile ? (
          <div className="pane-empty">
            {openImagePaths.length === 0
              ? "画像ファイルを選択すると、ここにプレビューを表示します。"
              : "タブから表示する画像を選択してください。"}
          </div>
        ) : imageFailed ? (
          <div className="pane-empty">画像を表示できませんでした。（取得に失敗またはタイムアウト）</div>
        ) : !imageObjectUrl ? (
          <div className="pane-empty">読み込み中...</div>
        ) : (
          <div className="editor-image-wrap">
            <img
              className="editor-image"
              src={imageObjectUrl}
              alt={filePath ?? "preview"}
              onError={() => setImageFailed(true)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

