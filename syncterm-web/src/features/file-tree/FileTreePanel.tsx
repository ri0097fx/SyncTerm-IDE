import React, { useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import type { FileEntry } from "../../types/domain";
import { api } from "../../lib/api";

interface Props {
  onOpenFile?: (path: string) => void;
}

export const FileTreePanel: React.FC<Props> = ({ onOpenFile }) => {
  const { currentWatcher, currentSession } = useSession();
  const [roots, setRoots] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkSourcePath, setLinkSourcePath] = useState("");
  const [linkName, setLinkName] = useState("project_link");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!currentWatcher || !currentSession) {
        setRoots([]);
        return;
      }
      setLoading(true);
      try {
        const entries = await api.listFiles(currentWatcher.id, currentSession.name);
        setRoots(entries);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [currentWatcher, currentSession]);

  const refreshTree = async () => {
    if (!currentWatcher || !currentSession) return;
    setLoading(true);
    setTreeError(null);
    try {
      const entries = await api.listFiles(currentWatcher.id, currentSession.name);
      setRoots(entries);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Failed to refresh file tree");
    } finally {
      setLoading(false);
    }
  };

  const updateChildren = (items: FileEntry[], path: string, children: FileEntry[]): FileEntry[] =>
    items.map((node) => {
      if (node.path === path) {
        return { ...node, children, hasChildren: children.length > 0 };
      }
      if (node.children && node.children.length > 0) {
        return { ...node, children: updateChildren(node.children, path, children) };
      }
      return node;
    });

  const handleExpand = async (entry: FileEntry) => {
    if (!currentWatcher || !currentSession) return;
    if (entry.kind === "file") return;
    if (entry.children && entry.children.length > 0) return;
    if (!entry.hasChildren) return;
    setLoadingPath(entry.path);
    setTreeError(null);
    try {
      const children = await api.listChildren(currentWatcher.id, currentSession.name, entry.path);
      setRoots((prev) => updateChildren(prev, entry.path, children));
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Failed to expand directory/symlink");
    } finally {
      setLoadingPath(null);
    }
  };

  const handleSelect = (entry: FileEntry) => {
    setSelectedPath(entry.path);
    if (entry.kind === "file" && onOpenFile) {
      onOpenFile(entry.path);
    }
  };

  const openCreateSymlinkDialog = () => {
    if (!currentWatcher || !currentSession) return;
    setLinkError(null);
    setLinkSourcePath("");
    setLinkName("project_link");
    setShowLinkDialog(true);
  };

  const submitCreateSymlink = async () => {
    if (!currentWatcher || !currentSession) return;
    const source = linkSourcePath.trim();
    const name = linkName.trim();
    if (!source) {
      setLinkError("Source path を入力してください。");
      return;
    }
    if (!name) {
      setLinkError("Link name を入力してください。");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setLinkError("Link name に / と \\ は使えません。");
      return;
    }
    setLinkSubmitting(true);
    setLinkError(null);
    try {
      await api.createSymlink(currentWatcher.id, currentSession.name, source, name);
      setShowLinkDialog(false);
      // watcher poll interval is short; wait a moment then refresh tree.
      window.setTimeout(() => {
        void refreshTree();
      }, 1200);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "リンク作成に失敗しました。");
    } finally {
      setLinkSubmitting(false);
    }
  };

  return (
    <div className="pane pane-left">
      <div className="pane-header">
        <span className="pane-title">Files</span>
        <div className="pane-header-actions">
          <button className="primary-button" onClick={openCreateSymlinkDialog}>
            Link Folder
          </button>
          <button className="icon-button" onClick={() => void refreshTree()} title="Refresh tree">
            ↻
          </button>
        </div>
      </div>
      <div className="pane-body file-tree-scroll">
        {roots.map((entry) => (
          <TreeNode
            key={entry.id}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            onExpand={handleExpand}
            loadingPath={loadingPath}
          />
        ))}
        {loading && <div className="pane-empty">Loading...</div>}
        {treeError && <div className="pane-empty" style={{ color: "#fca5a5" }}>{treeError}</div>}
        {roots.length === 0 && (
          <div className="pane-empty">Watcher / Session を選択するとファイルが表示されます。</div>
        )}
      </div>

      {showLinkDialog && (
        <div className="modal-overlay" onClick={() => setShowLinkDialog(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remote Link Folder</h3>
            <label className="modal-label">
              Source Path (on Watcher)
              <input
                className="modal-input"
                value={linkSourcePath}
                onChange={(e) => setLinkSourcePath(e.target.value)}
                placeholder="/home/user/project"
              />
            </label>
            <label className="modal-label">
              Link Name (in session root)
              <input
                className="modal-input"
                value={linkName}
                onChange={(e) => setLinkName(e.target.value)}
                placeholder="project_link"
              />
            </label>
            {linkError && <div className="modal-error">{linkError}</div>}
            <div className="modal-actions">
              <button
                className="icon-button"
                style={{ width: "auto", padding: "0 0.8rem", borderRadius: "999px" }}
                onClick={() => setShowLinkDialog(false)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={linkSubmitting} onClick={() => void submitCreateSymlink()}>
                {linkSubmitting ? "Creating..." : "Create Link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface NodeProps {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: FileEntry) => void;
  onExpand: (entry: FileEntry) => void;
  loadingPath: string | null;
}

const TreeNode: React.FC<NodeProps> = ({ entry, depth, selectedPath, onSelect, onExpand, loadingPath }) => {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = (entry.children && entry.children.length > 0) || !!entry.hasChildren;
  const isSelected = selectedPath === entry.path;
  const isLoading = loadingPath === entry.path;

  const icon =
    entry.kind === "symlink"
      ? "🔗"
      : entry.kind === "dir"
      ? open
        ? "📂"
        : "📁"
      : "📄";
  const caret = hasChildren ? (open ? "▼" : "▶") : " ";

  return (
    <div>
      <button
        type="button"
        className={`tree-row ${isSelected ? "tree-row-selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (entry.kind !== "file") {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) {
              void onExpand(entry);
            }
          }
          onSelect(entry);
        }}
      >
        <span style={{ width: 14, opacity: hasChildren ? 0.9 : 0.25 }}>{caret}</span>
        <span className="tree-row-icon">{icon}</span>
        <span className="tree-row-label">
          {entry.name}
          {isLoading ? " (loading...)" : ""}
        </span>
      </button>
      {hasChildren && open && (
        <div>
          {(entry.children ?? []).map((child) => (
            <TreeNode
              key={child.id}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onExpand={onExpand}
              loadingPath={loadingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

