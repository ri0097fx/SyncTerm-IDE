import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import type { FileEntry } from "../../types/domain";
import { api } from "../../lib/api";

function parentPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}
function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir + "/" + name;
}

function findEntryByPath(entries: FileEntry[], path: string): FileEntry | undefined {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children?.length) {
      const found = findEntryByPath(e.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

interface Props {
  onOpenFile?: (path: string) => void;
}

type ClipboardKind = "copy" | "cut";

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

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clipboard, setClipboard] = useState<{ path: string; kind: ClipboardKind } | null>(null);

  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionParentPath, setActionParentPath] = useState("");
  const [actionEntry, setActionEntry] = useState<FileEntry | null>(null);
  const [newName, setNewName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

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

  const refreshTree = useCallback(async () => {
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
  }, [currentWatcher, currentSession]);

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

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const getParentForCreate = (entry: FileEntry | null): string => {
    if (!entry) return "";
    if (entry.kind === "dir" || entry.kind === "symlink") return entry.path;
    return parentPath(entry.path);
  };

  const openNewFile = () => {
    setContextMenu(null);
    setActionParentPath(getParentForCreate(contextMenu?.entry ?? null));
    setNewName("");
    setActionError(null);
    setShowNewFile(true);
  };
  const openNewFolder = () => {
    setContextMenu(null);
    setActionParentPath(getParentForCreate(contextMenu?.entry ?? null));
    setNewName("");
    setActionError(null);
    setShowNewFolder(true);
  };
  const openRename = () => {
    const e = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
    setContextMenu(null);
    if (!e) return;
    setActionEntry(e);
    setNewName(baseName(e.path));
    setActionError(null);
    setShowRename(true);
  };
  const openDeleteConfirm = () => {
    const e = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
    setContextMenu(null);
    if (!e) return;
    setActionEntry(e);
    setActionError(null);
    setShowDeleteConfirm(true);
  };

  const runWithRefresh = async (fn: () => Promise<unknown>) => {
    if (!currentWatcher || !currentSession) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
      window.setTimeout(() => void refreshTree(), 1500);
      window.setTimeout(() => void refreshTree(), 4000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const submitNewFile = async () => {
    const name = newName.trim();
    if (!name) {
      setActionError("名前を入力してください。");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setActionError("名前に / と \\ は使えません。");
      return;
    }
    const path = joinPath(actionParentPath, name);
    await runWithRefresh(() => api.createPath(currentWatcher!.id, currentSession!.name, path, "file"));
    setShowNewFile(false);
  };
  const submitNewFolder = async () => {
    const name = newName.trim();
    if (!name) {
      setActionError("名前を入力してください。");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setActionError("名前に / と \\ は使えません。");
      return;
    }
    const path = joinPath(actionParentPath, name);
    await runWithRefresh(() => api.createPath(currentWatcher!.id, currentSession!.name, path, "dir"));
    setShowNewFolder(false);
  };
  const submitRename = async () => {
    if (!actionEntry) return;
    const name = newName.trim();
    if (!name || name.includes("/") || name.includes("\\")) {
      setActionError("有効な名前を入力してください。");
      return;
    }
    const destPath = joinPath(parentPath(actionEntry.path), name);
    await runWithRefresh(() =>
      api.movePath(currentWatcher!.id, currentSession!.name, actionEntry.path, destPath)
    );
    setShowRename(false);
    setActionEntry(null);
  };
  const submitDelete = async () => {
    if (!actionEntry) return;
    await runWithRefresh(() =>
      api.deletePath(currentWatcher!.id, currentSession!.name, actionEntry.path)
    );
    setShowDeleteConfirm(false);
    setActionEntry(null);
    if (clipboard?.path === actionEntry.path && clipboard?.kind === "cut") setClipboard(null);
  };

  const handleCopy = () => {
    const e = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
    setContextMenu(null);
    if (e) setClipboard({ path: e.path, kind: "copy" });
  };
  const handleCut = () => {
    const e = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
    setContextMenu(null);
    if (e) setClipboard({ path: e.path, kind: "cut" });
  };
  const handlePaste = async () => {
    if (!clipboard || !currentWatcher || !currentSession) return;
    setContextMenu(null);
    const destDir = contextMenu?.entry
      ? (contextMenu.entry.kind === "dir" || contextMenu.entry.kind === "symlink"
          ? contextMenu.entry.path
          : parentPath(contextMenu.entry.path))
      : selectedPath
      ? (() => {
          const entry = findEntryByPath(roots, selectedPath);
          return entry && (entry.kind === "dir" || entry.kind === "symlink") ? entry.path : parentPath(selectedPath);
        })()
      : "";
    const destPath = joinPath(destDir, baseName(clipboard.path));
    if (clipboard.kind === "cut") {
      await runWithRefresh(() => api.movePath(currentWatcher.id, currentSession.name, clipboard.path, destPath));
      setClipboard(null);
    } else {
      await runWithRefresh(() => api.copyPath(currentWatcher.id, currentSession.name, clipboard.path, destPath));
    }
  };

  const handleDownload = async () => {
    const e = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
    setContextMenu(null);
    if (!e || e.kind !== "file") return;
    const path = e.path;
    if (!currentWatcher || !currentSession) return;
    try {
      const content = await api.fetchFileContent(currentWatcher.id, currentSession.name, path);
      const blob = new Blob([content], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = baseName(path);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : "Download failed");
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
      window.setTimeout(() => void refreshTree(), 4000);
      window.setTimeout(() => void refreshTree(), 8000);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "リンク作成に失敗しました。");
    } finally {
      setLinkSubmitting(false);
    }
  };

  const onContextMenuOpen = (e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const canPaste = !!clipboard && !!currentWatcher && !!currentSession;
  const contextEntry = contextMenu?.entry ?? (selectedPath ? findEntryByPath(roots, selectedPath) : undefined);
  const showDownload = contextEntry?.kind === "file";

  return (
    <div className="pane pane-left">
      <div className="pane-header">
        <span className="pane-title">Files</span>
        <div className="pane-header-actions">
          <button className="primary-button" onClick={openCreateSymlinkDialog} title="Link Folder">
            Link Folder
          </button>
          <button className="icon-button" onClick={() => void refreshTree()} title="Refresh tree">
            ↻
          </button>
        </div>
      </div>
      <div
        className="pane-body file-tree-scroll"
        onContextMenu={(e) => onContextMenuOpen(e, null)}
      >
        {roots.map((entry) => (
          <TreeNode
            key={entry.id}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            onExpand={handleExpand}
            onContextMenu={onContextMenuOpen}
            loadingPath={loadingPath}
          />
        ))}
        {loading && <div className="pane-empty">Loading...</div>}
        {treeError && <div className="pane-empty" style={{ color: "#fca5a5" }}>{treeError}</div>}
        {roots.length === 0 && (
          <div className="pane-empty">Watcher / Session を選択するとファイルが表示されます。</div>
        )}
      </div>

      {contextMenu && (
        <div
          className="file-tree-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={openNewFile}>New File</button>
          <button type="button" onClick={openNewFolder}>New Folder</button>
          <div className="context-menu-sep" />
          <button type="button" onClick={handleCopy}>Copy</button>
          <button type="button" onClick={handleCut}>Cut</button>
          <button type="button" onClick={handlePaste} disabled={!canPaste}>Paste</button>
          <button type="button" onClick={openRename} disabled={!contextEntry}>Rename</button>
          {showDownload && <button type="button" onClick={handleDownload}>Download</button>}
          <div className="context-menu-sep" />
          <button type="button" onClick={openDeleteConfirm} disabled={!contextEntry}>Delete</button>
        </div>
      )}

      {showNewFile && (
        <div className="modal-overlay" onClick={() => setShowNewFile(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">New File</h3>
            <label className="modal-label">
              Name
              <input
                className="modal-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="filename.txt"
                autoFocus
              />
            </label>
            {actionParentPath && <p className="modal-hint">Parent: {actionParentPath || "(root)"}</p>}
            {actionError && <div className="modal-error">{actionError}</div>}
            <div className="modal-actions">
              <button className="icon-button" style={{ width: "auto", padding: "0 0.8rem" }} onClick={() => setShowNewFile(false)}>Cancel</button>
              <button className="primary-button" disabled={actionBusy} onClick={() => void submitNewFile()}>{actionBusy ? "Creating..." : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {showNewFolder && (
        <div className="modal-overlay" onClick={() => setShowNewFolder(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">New Folder</h3>
            <label className="modal-label">
              Name
              <input
                className="modal-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="folder_name"
                autoFocus
              />
            </label>
            {actionParentPath && <p className="modal-hint">Parent: {actionParentPath || "(root)"}</p>}
            {actionError && <div className="modal-error">{actionError}</div>}
            <div className="modal-actions">
              <button className="icon-button" style={{ width: "auto", padding: "0 0.8rem" }} onClick={() => setShowNewFolder(false)}>Cancel</button>
              <button className="primary-button" disabled={actionBusy} onClick={() => void submitNewFolder()}>{actionBusy ? "Creating..." : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {showRename && actionEntry && (
        <div className="modal-overlay" onClick={() => setShowRename(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Rename</h3>
            <label className="modal-label">
              Name
              <input
                className="modal-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={actionEntry.name}
                autoFocus
              />
            </label>
            {actionError && <div className="modal-error">{actionError}</div>}
            <div className="modal-actions">
              <button className="icon-button" style={{ width: "auto", padding: "0 0.8rem" }} onClick={() => setShowRename(false)}>Cancel</button>
              <button className="primary-button" disabled={actionBusy} onClick={() => void submitRename()}>{actionBusy ? "Renaming..." : "Rename"}</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && actionEntry && (
        <div className="modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete</h3>
            <p>Delete &quot;{actionEntry.name}&quot;? This cannot be undone.</p>
            {actionError && <div className="modal-error">{actionError}</div>}
            <div className="modal-actions">
              <button className="icon-button" style={{ width: "auto", padding: "0 0.8rem" }} onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="primary-button" disabled={actionBusy} onClick={() => void submitDelete()} style={{ background: "#b91c1c" }}>{actionBusy ? "Deleting..." : "Delete"}</button>
            </div>
          </div>
        </div>
      )}

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
              <button className="icon-button" style={{ width: "auto", padding: "0 0.8rem", borderRadius: "999px" }} onClick={() => setShowLinkDialog(false)}>Cancel</button>
              <button className="primary-button" disabled={linkSubmitting} onClick={() => void submitCreateSymlink()}>{linkSubmitting ? "Creating..." : "Create Link"}</button>
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
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  loadingPath: string | null;
}

const TreeNode: React.FC<NodeProps> = ({ entry, depth, selectedPath, onSelect, onExpand, onContextMenu, loadingPath }) => {
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
            if (nextOpen) void onExpand(entry);
          }
          onSelect(entry);
        }}
        onContextMenu={(e) => onContextMenu(e, entry)}
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
              onContextMenu={onContextMenu}
              loadingPath={loadingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};
