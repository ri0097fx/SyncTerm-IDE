import React from "react";
import { createPortal } from "react-dom";
import { useSession } from "../session/SessionContext";
import { useExtensions } from "./ExtensionContext";
import { MarketplaceExtensionIcon, MarketplacePlaySurface } from "./MarketplaceVisualPreviews";

interface MarketplaceModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  DevTools: "🛠",
  Productivity: "📋",
  Game: "🎮",
};

export const MarketplaceModal: React.FC<MarketplaceModalProps> = ({ open, onClose }) => {
  const { currentWatcher, currentSession } = useSession();
  const { catalog, installed, sessionState, loading, error, refreshAll, installExtension, uninstallExtension, setSessionEnabled } =
    useExtensions();
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [installFilter, setInstallFilter] = React.useState<"all" | "not-installed" | "installed">("all");
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const installedMap = React.useMemo(() => {
    const m = new Map<string, (typeof installed)[number]>();
    for (const item of installed) m.set(item.extensionId, item);
    return m;
  }, [installed]);

  const categories = React.useMemo(() => {
    const set = new Set<string>();
    for (const item of catalog) {
      for (const c of item.manifest.categories) set.add(c);
    }
    return ["all", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [catalog]);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = catalog.filter((entry) => {
      if (category !== "all" && !entry.manifest.categories.includes(category)) return false;
      const isInst = installedMap.has(entry.manifest.id);
      if (installFilter === "not-installed" && isInst) return false;
      if (installFilter === "installed" && !isInst) return false;
      if (!q) return true;
      const haystack = [entry.manifest.id, entry.manifest.name, entry.manifest.publisher, entry.manifest.description, ...entry.manifest.tags]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    filtered.sort((a, b) => {
      const aInst = installedMap.has(a.manifest.id) ? 1 : 0;
      const bInst = installedMap.has(b.manifest.id) ? 1 : 0;
      if (aInst !== bInst) return aInst - bInst;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
    return filtered;
  }, [catalog, category, installFilter, installedMap, query]);

  const stats = React.useMemo(() => {
    const total = catalog.length;
    const inst = installed.length;
    const enabled = Object.values(sessionState?.enabled ?? {}).filter(Boolean).length;
    return { total, inst, enabled };
  }, [catalog.length, installed.length, sessionState?.enabled]);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="mp-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mp-header">
          <div className="mp-header-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            <span>Extensions</span>
          </div>
          <div className="mp-header-stats">
            <span className="mp-stat"><strong>{stats.total}</strong> available</span>
            <span className="mp-stat-sep" />
            <span className="mp-stat"><strong>{stats.inst}</strong> installed</span>
            <span className="mp-stat-sep" />
            <span className="mp-stat"><strong>{stats.enabled}</strong> enabled</span>
          </div>
          <button className="mp-close-btn" onClick={onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="mp-toolbar">
          <div className="mp-search-wrap">
            <svg className="mp-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
            <input
              className="mp-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions..."
            />
          </div>
          <div className="mp-filter-row">
            <div className="mp-category-pills">
              {categories.map((c) => (
                <button
                  key={c}
                  className={`mp-pill${category === c ? " mp-pill-active" : ""}`}
                  onClick={() => setCategory(c)}
                >
                  {c !== "all" && <span className="mp-pill-icon">{CATEGORY_ICONS[c] ?? "📦"}</span>}
                  {c === "all" ? "All" : c}
                </button>
              ))}
            </div>
            <select className="mp-select" value={installFilter} onChange={(e) => setInstallFilter(e.target.value as "all" | "not-installed" | "installed")}>
              <option value="all">All Status</option>
              <option value="not-installed">Not Installed</option>
              <option value="installed">Installed Only</option>
            </select>
            <button className="mp-refresh-btn" onClick={() => void refreshAll()} title="Refresh catalog">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8a6 6 0 0110.89-3.48M14 2v4h-4" />
                <path d="M14 8a6 6 0 01-10.89 3.48M2 14v-4h4" />
              </svg>
            </button>
          </div>
        </div>

        {error && <div className="mp-error">{error}</div>}
        {loading && <div className="mp-loading"><span className="mp-spinner" /> Loading...</div>}

        {/* Extension list */}
        <div className="mp-list">
          {rows.map((entry) => {
            const isInstalled = installedMap.has(entry.manifest.id);
            const enabled = !!sessionState?.enabled?.[entry.manifest.id];
            const isToggling = togglingId === entry.manifest.id;
            const isExpanded = expandedId === entry.manifest.id;
            const cat = entry.manifest.categories[0] ?? "";

            return (
              <div className={`mp-card${isInstalled ? " mp-card-installed" : ""}${enabled ? " mp-card-enabled" : ""}`} key={entry.manifest.id}>
                <div className="mp-card-main" onClick={() => setExpandedId(isExpanded ? null : entry.manifest.id)}>
                  <div className="mp-card-icon">
                    <MarketplaceExtensionIcon extensionId={entry.manifest.id} />
                  </div>
                  <div className="mp-card-info">
                    <div className="mp-card-title-row">
                      <span className="mp-card-name">{entry.manifest.name}</span>
                      <span className="mp-card-version">v{entry.manifest.version}</span>
                    </div>
                    <div className="mp-card-desc">{entry.manifest.description || "(no description)"}</div>
                    <div className="mp-card-meta">
                      <span className="mp-card-publisher">{entry.manifest.publisher}</span>
                      {cat && <span className="mp-card-cat">{CATEGORY_ICONS[cat] ?? "📦"} {cat}</span>}
                      {entry.manifest.tags.slice(0, 3).map((t) => (
                        <span key={t} className="mp-card-tag">#{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="mp-card-status">
                    {isInstalled && enabled && <span className="mp-badge mp-badge-enabled">ON</span>}
                    {isInstalled && !enabled && <span className="mp-badge mp-badge-disabled">OFF</span>}
                    {!isInstalled && <span className="mp-badge mp-badge-available">New</span>}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="mp-card-detail">
                    {entry.manifest.longDescription && (
                      <p className="mp-card-long-desc">{entry.manifest.longDescription}</p>
                    )}
                    {(entry.manifest.previewTitle ||
                      (entry.manifest.previewBullets && entry.manifest.previewBullets.length > 0) ||
                      (entry.manifest.previewMock && entry.manifest.previewMock.length > 0)) && (
                      <div className="mp-preview-card">
                        {entry.manifest.previewTitle && (
                          <div className="mp-preview-title">{entry.manifest.previewTitle}</div>
                        )}
                        {entry.manifest.previewBullets && entry.manifest.previewBullets.length > 0 && (
                          <ul className="mp-preview-bullets">
                            {entry.manifest.previewBullets.map((b, idx) => (
                              <li key={idx}>{b}</li>
                            ))}
                          </ul>
                        )}
                        <MarketplacePlaySurface manifest={entry.manifest} />
                      </div>
                    )}
                    <div className="mp-card-tags-full">
                      <span className="marketplace-tag">runtime:{entry.manifest.runtime ?? "manifest-only"}</span>
                      {(entry.manifest.permissions ?? []).map((perm) => (
                        <span key={perm} className="marketplace-tag">perm:{perm}</span>
                      ))}
                      {entry.manifest.categories.map((x) => (
                        <span key={x} className="marketplace-tag">{x}</span>
                      ))}
                      {entry.manifest.tags.map((x) => (
                        <span key={x} className="marketplace-tag">#{x}</span>
                      ))}
                    </div>
                    <div className="mp-card-actions">
                      {!isInstalled ? (
                        <button className="mp-btn mp-btn-install" onClick={() => void installExtension(entry.manifest.id)}>
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 2v9M4.5 7.5L8 11l3.5-3.5" /><path d="M3 13h10" /></svg>
                          Install
                        </button>
                      ) : (
                        <>
                          {currentWatcher && currentSession && (
                            <button
                              className={`mp-btn ${enabled ? "mp-btn-disable" : "mp-btn-enable"}`}
                              disabled={isToggling}
                              onClick={() => {
                                setTogglingId(entry.manifest.id);
                                setSessionEnabled(entry.manifest.id, !enabled);
                                setTimeout(() => setTogglingId((cur) => (cur === entry.manifest.id ? null : cur)), 400);
                              }}
                            >
                              {isToggling ? "..." : enabled ? "Disable" : "Enable"}
                            </button>
                          )}
                          <button
                            className="mp-btn mp-btn-uninstall"
                            onClick={() => void uninstallExtension(entry.manifest.id)}
                          >
                            Uninstall
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!loading && rows.length === 0 && <div className="mp-empty">一致する拡張機能がありません。</div>}
        </div>

        {/* Footer */}
        <div className="mp-footer">
          <span className="mp-footer-note">
            {currentWatcher && currentSession
              ? `Session: ${currentWatcher.id}/${currentSession.name}`
              : "Watcher/Session を選択すると Enable/Disable が可能になります。"}
          </span>
          <span className="mp-footer-count">{rows.length} / {catalog.length} shown</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};
