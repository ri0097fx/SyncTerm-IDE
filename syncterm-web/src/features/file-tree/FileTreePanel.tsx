import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionContext";
import { usePreferences } from "../preferences/PreferencesContext";
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

function flattenEntries(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const e of entries) {
    out.push(e);
    if (e.children?.length) out.push(...flattenEntries(e.children));
  }
  return out;
}

function snapshotChildrenByPath(entries: FileEntry[]): Map<string, FileEntry[]> {
  const map = new Map<string, FileEntry[]>();
  const walk = (nodes: FileEntry[]) => {
    for (const n of nodes) {
      if (n.path !== "/" && n.children && n.children.length > 0) {
        map.set(n.path, n.children);
      }
      if (n.children && n.children.length > 0) {
        walk(n.children);
      }
    }
  };
  walk(entries);
  return map;
}

function mergeChildrenFromSnapshot(items: FileEntry[], snapshot: Map<string, FileEntry[]>): FileEntry[] {
  return items.map((node) => {
    let children = node.children;
    const snap = snapshot.get(node.path);
    if ((!children || children.length === 0) && snap && snap.length > 0) {
      children = snap;
    } else if (children && children.length > 0) {
      children = mergeChildrenFromSnapshot(children, snapshot);
    }
    return { ...node, children };
  });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, [...chunk]);
  }
  return btoa(binary);
}

interface Props {
  onOpenFile?: (path: string) => void;
}

type ClipboardKind = "copy" | "cut";

const FILE_TREE_DEBUG_MAX = 20;

export const FileTreePanel: React.FC<Props> = ({ onOpenFile }) => {
  const { currentWatcher, currentSession } = useSession();
  const { preferences } = usePreferences();
  const [roots, setRoots] = useState<FileEntry[]>([]);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set(["/"]));
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkSourcePath, setLinkSourcePath] = useState("");
  const [linkName, setLinkName] = useState("project_link");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; kind: ClipboardKind } | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [showRename, setShowRename] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionEntry, setActionEntry] = useState<FileEntry | null>(null);
  const [actionEntries, setActionEntries] = useState<FileEntry[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const [inlineCreate, setInlineCreate] = useState<
    | {
        parentDisplayPath: string;
        parentRelPath: string;
        kind: "file" | "dir";
      }
    | null
  >(null);
  const [inlineCreateName, setInlineCreateName] = useState("");

  /** デバッグ: Preferences の Show command trace が ON のとき、フォルダツリー操作のログ（原因調査用） */
  const [fileTreeDebugLog, setFileTreeDebugLog] = useState<Array<{ op: string; params: string; result: string }>>([]);

  /** デバッグ用: showCommandTrace が ON のとき API の入出力を console と fileTreeDebugLog に記録 */
  const runWithTrace = useCallback(
    async function runWithTrace<T>(
      op: string,
      params: Record<string, unknown>,
      fn: () => Promise<T>
    ): Promise<T> {
      if (!preferences?.showCommandTrace) return fn();
      const paramsStr = JSON.stringify(params);
      console.log(`[FileTree] ${op}`, params);
      setFileTreeDebugLog((prev) =>
        prev.length >= FILE_TREE_DEBUG_MAX
          ? [...prev.slice(1), { op, params: paramsStr, result: "..." }]
          : [...prev, { op, params: paramsStr, result: "..." }]
      );
      try {
        const res = await fn();
        const resultStr = (() => {
          if (Array.isArray(res)) {
            const topSample = res
              .slice(0, 3)
              .map((x) =>
                x && typeof x === "object" && "path" in x
                  ? String((x as { path?: unknown }).path)
                  : typeof x === "string"
                  ? x
                  : typeof x
              )
              .join(", ");
            const first = res[0] as unknown;
            const childrenInfo = (() => {
              if (!first || typeof first !== "object") return "";
              if (!("children" in first)) return "";
              const ch = (first as { children?: unknown }).children;
              if (!Array.isArray(ch)) return " children=[non-array]";
              const chSample = ch
                .slice(0, 4)
                .map((x) =>
                  x && typeof x === "object" && "path" in x
                    ? String((x as { path?: unknown }).path)
                    : typeof x
                )
                .join(", ");
              return ` childrenLen=${ch.length}${chSample ? ` childrenSample=[${chSample}]` : ""}`;
            })();
            return `array(len=${res.length})${topSample ? ` sample=[${topSample}]` : ""}${childrenInfo}`;
          }
          if (typeof res === "object" && res !== null && "ok" in res) {
            return `ok=${(res as { ok?: boolean }).ok} rt=${(res as { rt?: boolean }).rt}`;
          }
          if (typeof res === "object" && res !== null) {
            try {
              const s = JSON.stringify(res);
              return s.length > 300 ? `${s.slice(0, 300)}…` : s;
            } catch {
              return "[object]";
            }
          }
          return String(res);
        })();
        console.log(`[FileTree] ${op} result`, res);
        setFileTreeDebugLog((prev) => {
          const next = [...prev];
          if (next.length) next[next.length - 1] = { ...next[next.length - 1], result: resultStr };
          return next;
        });
        return res;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[FileTree] ${op} error`, e);
        setFileTreeDebugLog((prev) => {
          const next = [...prev];
          if (next.length) next[next.length - 1] = { ...next[next.length - 1], result: `ERROR: ${msg}` };
          return next;
        });
        throw e;
      }
    },
    [preferences?.showCommandTrace]
  );

  useEffect(() => {
    // watcher/session 切替時に展開状態とインライン作成状態をクリア
    setOpenPaths(new Set(["/"]));
    setInlineCreate(null);
    setInlineCreateName("");
    setActionError(null);
    setTreeError(null);
  }, [currentWatcher?.id, currentSession?.name]);

  useEffect(() => {
    if (!inlineCreate) return;
    const handleClick = () => {
      setInlineCreate(null);
      setInlineCreateName("");
      setActionError(null);
    };
    window.addEventListener("click", handleClick);
    return () => {
      window.removeEventListener("click", handleClick);
    };
  }, [inlineCreate]);

  useEffect(() => {
    const load = async () => {
      if (!currentWatcher || !currentSession) {
        setRoots([]);
        return;
      }
      setLoading(true);
      try {
        const entries = await runWithTrace(
          "listFiles",
          { watcherId: currentWatcher.id, session: currentSession.name, source: "relay" },
          () => api.listFiles(currentWatcher.id, currentSession.name)
        );
        setRoots(entries);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [currentWatcher, currentSession]);

  const refreshTree = useCallback(async () => {
    if (!currentWatcher || !currentSession) return;
    // 展開済みディレクトリ / シンボリックリンクの children をスナップショットしておき、リフレッシュ後に復元する
    const snapshot = snapshotChildrenByPath(roots);
    setLoading(true);
    setTreeError(null);
    try {
      // Refresh は relay 側の session mirror を正として取得する。
      // watcher 側は（RT 実行用に）commands.* しか持たない構成もあり、root を watcher 起点にするとツリーが欠落する。
      const entries = await runWithTrace(
        "listFiles",
        { watcherId: currentWatcher.id, session: currentSession.name, source: "relay" },
        () => api.listFiles(currentWatcher.id, currentSession.name)
      );
      const merged = snapshot.size ? mergeChildrenFromSnapshot(entries, snapshot) : entries;
      setRoots(merged);

      // 深い階層は root の listFiles だけでは更新されないので、展開中フォルダも再取得する
      const expanded = Array.from(openPaths).filter((p) => p && p !== "/");
      const maxRefresh = 30;
      for (const p of expanded.slice(0, maxRefresh)) {
        try {
          const children = await runWithTrace(
            "listChildren",
            { watcherId: currentWatcher.id, session: currentSession.name, path: p },
            () => api.listChildren(currentWatcher.id, currentSession.name, p)
          );
          setRoots((prev) => updateChildren(prev, p, children));
        } catch (e) {
          // 1 個の失敗で全体を止めない（原因は debug log に残る）
          console.warn("[FileTree] refresh expanded failed", p, e);
        }
      }
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Failed to refresh file tree");
    } finally {
      setLoading(false);
    }
  }, [currentWatcher, currentSession, openPaths, roots, runWithTrace]);

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
      const children = await runWithTrace(
        "listChildren",
        { watcherId: currentWatcher.id, session: currentSession.name, path: entry.path },
        () => api.listChildren(currentWatcher.id, currentSession.name, entry.path)
      );
      setRoots((prev) => updateChildren(prev, entry.path, children));
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Failed to expand directory/symlink");
    } finally {
      setLoadingPath(null);
    }
  };

  const flatList = React.useMemo(() => flattenEntries(roots), [roots]);

  const handleSelect = useCallback(
    (entry: FileEntry, e?: React.MouseEvent) => {
      if (e?.ctrlKey || e?.metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        setLastSelectedPath(entry.path);
      } else if (e?.shiftKey) {
        const idx = flatList.findIndex((x) => x.path === entry.path);
        const lastIdx = lastSelectedPath != null ? flatList.findIndex((x) => x.path === lastSelectedPath) : -1;
        const from = lastIdx < 0 ? idx : Math.min(idx, lastIdx);
        const to = lastIdx < 0 ? idx : Math.max(idx, lastIdx);
        const paths = flatList.slice(from, to + 1).map((x) => x.path);
        setSelectedPaths(new Set(paths));
        setLastSelectedPath(entry.path);
      } else {
        setSelectedPaths(new Set([entry.path]));
        setLastSelectedPath(entry.path);
        if (entry.kind === "file" && onOpenFile) onOpenFile(entry.path);
      }
    },
    [flatList, lastSelectedPath, onOpenFile]
  );

  const getSelectedPaths = useCallback(() => Array.from(selectedPaths), [selectedPaths]);
  const getContextEntries = useCallback((): FileEntry[] => {
    const entry = contextMenu?.entry ?? null;
    if (entry) return [entry];
    return getSelectedPaths()
      .map((p) => findEntryByPath(roots, p))
      .filter((e): e is FileEntry => e != null);
  }, [contextMenu?.entry, roots, getSelectedPaths]);

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

  const getParentForCreate = (
    entry: FileEntry | null
  ): { parentDisplayPath: string; parentRelPath: string } => {
    // 右クリック対象がない場合はルート直下に作成
    if (!entry) return { parentDisplayPath: "/", parentRelPath: "" };
    if (entry.path === "/") return { parentDisplayPath: "/", parentRelPath: "" };
    if (entry.kind === "dir" || entry.kind === "symlink") {
      // ディレクトリ/リンク自体の直下に作成
      const rel = entry.path.replace(/^\//, "");
      return { parentDisplayPath: entry.path, parentRelPath: rel };
    }
    // ファイル上での New はその親ディレクトリに対して行う（表示は "/dir", 内部の相対パスは "dir"）
    const relParent = parentPath(entry.path); // 先頭スラッシュなし
    const display = relParent ? `/${relParent}` : "/";
    return { parentDisplayPath: display, parentRelPath: relParent };
  };

  const openNewFile = () => {
    const { parentDisplayPath, parentRelPath } = getParentForCreate(contextMenu?.entry ?? null);
    setContextMenu(null);
    setInlineCreate({ parentDisplayPath, parentRelPath, kind: "file" });
    setInlineCreateName("");
    setActionError(null);
    setTreeError(null);
    if (parentDisplayPath) {
      const e = findEntryByPath(roots, parentDisplayPath);
      if (e) {
        setOpenPaths((prev) => new Set(prev).add(e.path));
        void handleExpand(e);
      }
    }
  };
  const openNewFolder = () => {
    const { parentDisplayPath, parentRelPath } = getParentForCreate(contextMenu?.entry ?? null);
    setContextMenu(null);
    setInlineCreate({ parentDisplayPath, parentRelPath, kind: "dir" });
    setInlineCreateName("");
    setActionError(null);
    setTreeError(null);
    if (parentDisplayPath) {
      const e = findEntryByPath(roots, parentDisplayPath);
      if (e) {
        setOpenPaths((prev) => new Set(prev).add(e.path));
        void handleExpand(e);
      }
    }
  };
  const openRename = () => {
    const entries = getContextEntries();
    setContextMenu(null);
    if (entries.length !== 1) return;
    setActionEntry(entries[0]);
    setActionEntries([]);
    setNewName(baseName(entries[0].path));
    setActionError(null);
    setShowRename(true);
  };
  const openDeleteConfirm = () => {
    const entries = getContextEntries();
    setContextMenu(null);
    if (!entries.length) return;
    setActionEntry(entries.length === 1 ? entries[0] : null);
    setActionEntries(entries.length > 1 ? entries : []);
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

  const submitInlineCreate = async () => {
    if (!inlineCreate || !currentWatcher || !currentSession) return;
    const name = inlineCreateName.trim();
    if (!name) {
      setActionError("名前を入力してください。");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setActionError("名前に / と \\ は使えません。");
      return;
    }
    const path = joinPath(inlineCreate.parentRelPath, name);
    await runWithRefresh(() =>
      runWithTrace("createPath", { path, kind: inlineCreate.kind }, () =>
        api.createPath(currentWatcher.id, currentSession.name, path, inlineCreate.kind)
      )
    );
    setInlineCreate(null);
    setInlineCreateName("");
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
      runWithTrace("movePath", { sourcePath: actionEntry.path, destPath }, () =>
        api.movePath(currentWatcher!.id, currentSession!.name, actionEntry.path, destPath)
      )
    );
    setShowRename(false);
    setActionEntry(null);
  };
  const submitDelete = async () => {
    const toDelete = actionEntries.length ? actionEntries : actionEntry ? [actionEntry] : [];
    if (!toDelete.length || !currentWatcher || !currentSession) return;
    await runWithRefresh(async () => {
      for (const e of toDelete) {
        await runWithTrace("deletePath", { path: e.path }, () =>
          api.deletePath(currentWatcher.id, currentSession.name, e.path)
        );
      }
    });
    setShowDeleteConfirm(false);
    setActionEntry(null);
    setActionEntries([]);
    if (clipboard?.paths.length) {
      const deleted = new Set(toDelete.map((e) => e.path));
      const next = clipboard.paths.filter((p) => !deleted.has(p));
      setClipboard(next.length ? { ...clipboard, paths: next } : null);
    }
  };

  const handleCopyPath = async () => {
    const entries = getContextEntries();
    setContextMenu(null);
    if (!entries.length) return;
    const text = entries.map((e) => e.path).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const handleCopy = () => {
    const entries = getContextEntries();
    setContextMenu(null);
    if (entries.length) setClipboard({ paths: entries.map((e) => e.path), kind: "copy" });
  };
  const handleCut = () => {
    const entries = getContextEntries();
    setContextMenu(null);
    if (entries.length) setClipboard({ paths: entries.map((e) => e.path), kind: "cut" });
  };
  const handlePaste = async () => {
    if (!clipboard?.paths.length || !currentWatcher || !currentSession) return;
    setContextMenu(null);
    const destDir = contextMenu?.entry
      ? (contextMenu.entry.kind === "dir" || contextMenu.entry.kind === "symlink"
          ? contextMenu.entry.path
          : parentPath(contextMenu.entry.path))
      : getSelectedPaths()[0] != null
      ? (() => {
          const entry = findEntryByPath(roots, getSelectedPaths()[0]);
          return entry && (entry.kind === "dir" || entry.kind === "symlink") ? entry.path : parentPath(getSelectedPaths()[0]);
        })()
      : "";
    await runWithRefresh(async () => {
      for (const path of clipboard.paths) {
        const destPath = joinPath(destDir, baseName(path));
        if (clipboard.kind === "cut") {
          await runWithTrace("movePath", { sourcePath: path, destPath }, () =>
            api.movePath(currentWatcher.id, currentSession.name, path, destPath)
          );
        } else {
          await runWithTrace("copyPath", { sourcePath: path, destPath }, () =>
            api.copyPath(currentWatcher.id, currentSession.name, path, destPath)
          );
        }
      }
    });
    if (clipboard.kind === "cut") setClipboard(null);
  };

  const handleDownload = async () => {
    const entries = getContextEntries().filter((e) => e.kind === "file");
    setContextMenu(null);
    if (!entries.length || !currentWatcher || !currentSession) return;
    try {
      for (let i = 0; i < entries.length; i++) {
        const path = entries[i].path;
        const blob = await api.getRawFileBlob(currentWatcher.id, currentSession.name, path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = baseName(path);
        a.click();
        URL.revokeObjectURL(url);
        if (i < entries.length - 1) await new Promise((r) => setTimeout(r, 200));
      }
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
      await runWithTrace("createSymlink", { sourcePath: source, linkName: name }, () =>
        api.createSymlink(currentWatcher.id, currentSession.name, source, name)
      );
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

  const canPaste = !!clipboard?.paths?.length && !!currentWatcher && !!currentSession;
  const contextEntries = getContextEntries();
  const singleContextEntry = contextEntries.length === 1 ? contextEntries[0] : null;
  const showDownload = contextEntries.some((e) => e.kind === "file");

  const handleDragStart = useCallback(
    (paths: string[]) => {
      setDragOverPath(null);
    },
    []
  );
  const handleDropMove = useCallback(
    async (destDir: string, paths: string[]) => {
      if (!currentWatcher || !currentSession) return;
      const toMove = paths.filter((p) => p !== destDir && !p.startsWith(destDir + "/"));
      await runWithRefresh(async () => {
        for (const path of toMove) {
          const destPath = joinPath(destDir, baseName(path));
          await runWithTrace("movePath", { sourcePath: path, destPath }, () =>
            api.movePath(currentWatcher.id, currentSession.name, path, destPath)
          );
        }
      });
      setDragOverPath(null);
    },
    [currentWatcher, currentSession, runWithRefresh, runWithTrace]
  );
  const handleDropFiles = useCallback(
    async (destDir: string, files: FileList | File[]) => {
      if (!currentWatcher || !currentSession) return;
      const arr = Array.from(files);
      setUploading(true);
      setTreeError(null);
      try {
        for (const file of arr) {
          const path = joinPath(destDir, file.name);
          const buf = await file.arrayBuffer();
          const contentBase64 = arrayBufferToBase64(buf);
          await api.uploadFile(currentWatcher.id, currentSession.name, path, contentBase64);
        }
        window.setTimeout(() => void refreshTree(), 1500);
        window.setTimeout(() => void refreshTree(), 4000);
      } catch (err) {
        setTreeError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        setDragOverPath(null);
      }
    },
    [currentWatcher, currentSession, refreshTree]
  );

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
      {preferences?.showCommandTrace && fileTreeDebugLog.length > 0 && (
        <div className="file-tree-debug-log" style={{ padding: "6px 8px", fontSize: "11px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border)" }}>
          <strong>File tree debug (last {fileTreeDebugLog.length} ops)</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: "16px", maxHeight: "120px", overflow: "auto" }}>
            {fileTreeDebugLog.map((line, i) => (
              <li key={i} style={{ marginBottom: 2 }}>
                <span style={{ color: "var(--accent)" }}>{line.op}</span> {line.params} → {line.result}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        className={`pane-body file-tree-scroll ${dragOverPath === "" ? "file-tree-drag-over" : ""}`}
        onContextMenu={(e) => onContextMenuOpen(e, null)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOverPath("");
          }
        }}
        onDragLeave={() => setDragOverPath((p) => (p === "" ? null : p))}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) {
            void handleDropFiles("", e.dataTransfer.files);
          } else if (e.dataTransfer.types.includes("application/json")) {
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/json"));
              if (data?.paths?.length) void handleDropMove("", data.paths);
            } catch {}
          }
          setDragOverPath(null);
        }}
      >
        {uploading && <div className="pane-empty">Uploading...</div>}
        {roots.map((entry) => (
          <TreeNode
            key={entry.id}
            entry={entry}
            depth={0}
            openPaths={openPaths}
            setOpenPaths={setOpenPaths}
            inlineCreate={inlineCreate}
            inlineCreateName={inlineCreateName}
            setInlineCreateName={setInlineCreateName}
            onSubmitInlineCreate={submitInlineCreate}
            onCancelInlineCreate={() => {
              setInlineCreate(null);
              setInlineCreateName("");
              setActionError(null);
            }}
            inlineCreateError={actionError}
            selectedPaths={selectedPaths}
            onSelect={handleSelect}
            onExpand={handleExpand}
            onContextMenu={onContextMenuOpen}
            loadingPath={loadingPath}
            getSelectedPaths={getSelectedPaths}
            dragOverPath={dragOverPath}
            setDragOverPath={setDragOverPath}
            onDropMove={handleDropMove}
            onDropFiles={handleDropFiles}
            onDragStart={handleDragStart}
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
          <button type="button" onClick={() => void handleCopyPath()} disabled={!contextEntries.length}>
            Copy path
          </button>
          <button type="button" onClick={openRename} disabled={!singleContextEntry}>Rename</button>
          {showDownload && <button type="button" onClick={handleDownload}>Download</button>}
          <div className="context-menu-sep" />
          <button type="button" onClick={openDeleteConfirm} disabled={!contextEntries.length}>Delete</button>
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

      {showDeleteConfirm && (actionEntry || actionEntries.length > 0) && (
        <div className="modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete</h3>
            <p>
              {actionEntries.length > 1
                ? `Delete ${actionEntries.length} items? This cannot be undone.`
                : actionEntry
                ? `Delete "${actionEntry.name}"? This cannot be undone.`
                : `Delete "${actionEntries[0]?.name}"? This cannot be undone.`}
            </p>
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
  openPaths: Set<string>;
  setOpenPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  inlineCreate:
    | {
        parentDisplayPath: string;
        parentRelPath: string;
        kind: "file" | "dir";
      }
    | null;
  inlineCreateName: string;
  setInlineCreateName: (name: string) => void;
  onSubmitInlineCreate: () => Promise<void>;
  onCancelInlineCreate: () => void;
  inlineCreateError: string | null;
  selectedPaths: Set<string>;
  onSelect: (entry: FileEntry, e?: React.MouseEvent) => void;
  onExpand: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  loadingPath: string | null;
  getSelectedPaths: () => string[];
  dragOverPath: string | null;
  setDragOverPath: (path: string | null) => void;
  onDropMove: (destDir: string, paths: string[]) => Promise<void>;
  onDropFiles: (destDir: string, files: FileList | File[]) => Promise<void>;
  onDragStart: (paths: string[]) => void;
}

const TreeNode: React.FC<NodeProps> = ({
  entry,
  depth,
  openPaths,
  setOpenPaths,
  inlineCreate,
  inlineCreateName,
  setInlineCreateName,
  onSubmitInlineCreate,
  onCancelInlineCreate,
  inlineCreateError,
  selectedPaths,
  onSelect,
  onExpand,
  onContextMenu,
  loadingPath,
  getSelectedPaths,
  dragOverPath,
  setDragOverPath,
  onDropMove,
  onDropFiles,
  onDragStart,
}) => {
  const open = openPaths.has(entry.path) || depth === 0;
  const hasChildren = (entry.children && entry.children.length > 0) || !!entry.hasChildren;
  const isSelected = selectedPaths.has(entry.path);
  const isLoading = loadingPath === entry.path;
  const isFolder = entry.kind === "dir" || entry.kind === "symlink";
  const isDragOver = dragOverPath === entry.path;

  const name = entry.name || "";
  const lowerName = name.toLowerCase();
  const canExpand = hasChildren && isFolder;

  const getSetiIconClass = (): string => {
    // フォルダは Seti アイコンではなく、展開ボタン（ケアット）をアイコン位置に表示する
    if (isFolder) return "";
    // Python
    if (lowerName.endsWith(".py")) return "file-tree-icon-python";
    // Shell (.sh) は Docker っぽいアイコンを避け、テキスト扱いに
    if (lowerName.endsWith(".sh")) return "file-tree-icon-text";
    // Markdown
    if (lowerName.endsWith(".md") || lowerName.endsWith(".mdx")) return "file-tree-icon-markdown";
    // JSON 系
    if (
      lowerName.endsWith(".json") ||
      lowerName.endsWith(".jsonc") ||
      lowerName.endsWith(".jsonl")
    ) {
      return "file-tree-icon-json";
    }
    // CSV
    if (lowerName.endsWith(".csv")) return "file-tree-icon-csv";
    // プレーンテキスト系
    if (lowerName.endsWith(".log") || lowerName.endsWith(".txt")) return "file-tree-icon-text";
    // 画像系
    if (
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".gif") ||
      lowerName.endsWith(".webp") ||
      lowerName.endsWith(".svg")
    ) {
      return "file-tree-icon-image";
    }
    // その他は汎用ファイルアイコン
    return "file-tree-icon-file";
  };

  const icon = isFolder && canExpand ? (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      {open ? (
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  ) : !isFolder ? (
    <span className={`file-tree-icon ${getSetiIconClass()}`} aria-hidden="true" />
  ) : (
    <span style={{ width: 12, display: "inline-block" }} aria-hidden="true" />
  );

  const handleDragStart = (e: React.DragEvent) => {
    onDragStart([]);
    const paths = getSelectedPaths();
    const toDrag = paths.length && selectedPaths.has(entry.path) ? paths : [entry.path];
    e.dataTransfer.setData("application/json", JSON.stringify({ paths: toDrag }));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.name);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      if (isFolder) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOverPath(entry.path);
      }
      return;
    }
    if (e.dataTransfer.types.includes("application/json") && isFolder) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverPath(entry.path);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      void onDropFiles(entry.path, e.dataTransfer.files);
    } else if (e.dataTransfer.types.includes("application/json")) {
      try {
        const data = JSON.parse(e.dataTransfer.getData("application/json"));
        if (data?.paths?.length) void onDropMove(entry.path, data.paths);
      } catch {}
    }
    setDragOverPath(null);
  };

  const handleDragLeave = () => {
    setDragOverPath(dragOverPath === entry.path ? null : dragOverPath);
  };

  return (
    <div
      className="tree-node"
      style={{ "--tree-depth": depth } as React.CSSProperties & { [key: string]: string | number }}
    >
      <button
        type="button"
        className={`tree-row ${isSelected ? "tree-row-selected" : ""} ${isDragOver ? "file-tree-drag-over" : ""}`}
        draggable
        onDragStart={handleDragStart}
        onDragOver={isFolder ? handleDragOver : undefined}
        onDragLeave={isFolder ? handleDragLeave : undefined}
        onDrop={isFolder ? handleDrop : undefined}
        onClick={(e) => {
          if (entry.kind !== "file") {
            const nextOpen = !open;
            setOpenPaths((prev) => {
              const next = new Set(prev);
              if (nextOpen) next.add(entry.path);
              else next.delete(entry.path);
              return next;
            });
            if (nextOpen) void onExpand(entry);
          }
          onSelect(entry, e);
        }}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className="tree-row-icon">{icon}</span>
        <span className="tree-row-label">
          {entry.name}
          {isLoading ? " (loading...)" : ""}
        </span>
      </button>
      {inlineCreate && inlineCreate.parentDisplayPath === entry.path && (
          <InlineCreateRow
            kind={inlineCreate.kind}
            value={inlineCreateName}
            error={inlineCreateError}
            busy={false}
            onChange={setInlineCreateName}
            onSubmit={onSubmitInlineCreate}
            onCancel={onCancelInlineCreate}
            depth={depth + 1}
          />
        )}
      {isFolder && open && (
        <div
          className="tree-node-children"
          style={{ "--tree-depth": depth } as React.CSSProperties & { [key: string]: string | number }}
        >
          {(entry.children ?? []).map((child) => (
            <TreeNode
              key={child.id}
              entry={child}
              depth={depth + 1}
              openPaths={openPaths}
              setOpenPaths={setOpenPaths}
              inlineCreate={inlineCreate}
              inlineCreateName={inlineCreateName}
              setInlineCreateName={setInlineCreateName}
              onSubmitInlineCreate={onSubmitInlineCreate}
              onCancelInlineCreate={onCancelInlineCreate}
              inlineCreateError={inlineCreateError}
              selectedPaths={selectedPaths}
              onSelect={onSelect}
              onExpand={onExpand}
              onContextMenu={onContextMenu}
              loadingPath={loadingPath}
              getSelectedPaths={getSelectedPaths}
              dragOverPath={dragOverPath}
              setDragOverPath={setDragOverPath}
              onDropMove={onDropMove}
              onDropFiles={onDropFiles}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const InlineCreateRow: React.FC<{
  kind: "file" | "dir";
  value: string;
  error: string | null;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  depth: number;
}> = ({ kind, value, error, busy, onChange, onSubmit, onCancel, depth }) => {
  const label = kind === "dir" ? "New Folder" : "New File";
  return (
    <div
      style={{ paddingLeft: 8 + depth * 14, paddingTop: 2, paddingBottom: 2 }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        className="modal-input"
        style={{ width: "100%", maxWidth: 320, padding: "2px 6px", height: 22, fontSize: 12 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void onSubmit();
          }
        }}
        disabled={busy}
      />
      {error && <div className="modal-error" style={{ marginTop: 4 }}>{error}</div>}
    </div>
  );
};
