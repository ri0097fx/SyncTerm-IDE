import React from "react";
import { useExtensions } from "./ExtensionContext";
import { MarketplaceExtensionIcon } from "./MarketplaceVisualPreviews";
import type { ExtensionCatalogEntry } from "../../types/domain";

interface QuickToggleProps {
  disabled: boolean;
}

function categorise(entries: ExtensionCatalogEntry[]) {
  const order = ["DevTools", "Productivity", "Game"];
  const groups: Record<string, ExtensionCatalogEntry[]> = {};
  for (const e of entries) {
    const cat = e.manifest.categories[0] ?? "Other";
    (groups[cat] ??= []).push(e);
  }
  const result: Array<{ category: string; entries: ExtensionCatalogEntry[] }> = [];
  for (const cat of order) {
    if (groups[cat]) {
      result.push({ category: cat, entries: groups[cat] });
      delete groups[cat];
    }
  }
  for (const [cat, entries] of Object.entries(groups)) {
    result.push({ category: cat, entries });
  }
  return result;
}

export const QuickToggle: React.FC<QuickToggleProps> = ({ disabled }) => {
  const { catalog, installed, sessionState, setSessionEnabled, setSessionEnabledBulk } = useExtensions();
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const wrapRef = React.useRef<HTMLSpanElement>(null);

  const installedSet = React.useMemo(() => new Set(installed.map((x) => x.extensionId)), [installed]);

  const installedEntries = React.useMemo(
    () => catalog.filter((c) => installedSet.has(c.manifest.id)).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [catalog, installedSet],
  );

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return installedEntries;
    return installedEntries.filter((x) => {
      const hay = `${x.manifest.name} ${x.manifest.id} ${x.manifest.tags.join(" ")} ${x.manifest.categories.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [installedEntries, filter]);

  const groups = React.useMemo(() => categorise(filtered), [filtered]);

  React.useEffect(() => {
    if (!open) return;
    const handle = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  const handleBulk = React.useCallback(
    async (enabled: boolean) => {
      setBulkBusy(true);
      try {
        setSessionEnabledBulk(installedEntries.map((x) => ({ extensionId: x.manifest.id, enabled })));
      } finally {
        setBulkBusy(false);
      }
    },
    [installedEntries, setSessionEnabledBulk],
  );

  return (
    <span className="session-quick-toggle-wrap" ref={wrapRef}>
      <button
        className={`icon-button ${open ? "active" : ""}`}
        style={{ width: "auto", padding: "0 0.5rem", marginLeft: "0.25rem" }}
        onClick={() => setOpen((v) => !v)}
        title="インストール済み拡張の有効化を一括/個別トグル"
        disabled={disabled || installedEntries.length === 0}
      >
        Quick Toggle ▾
      </button>

      {open && (
        <div className="session-quick-toggle-dropdown">
          <div className="session-quick-toggle-head">
            <input
              className="modal-input session-quick-toggle-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search installed extensions..."
            />
            <button
              className="icon-button"
              style={{ width: "auto", padding: "0 0.55rem" }}
              disabled={bulkBusy}
              onClick={() => handleBulk(true)}
            >
              All ON
            </button>
            <button
              className="icon-button"
              style={{ width: "auto", padding: "0 0.55rem" }}
              disabled={bulkBusy}
              onClick={() => handleBulk(false)}
            >
              All OFF
            </button>
          </div>

          <div className="quick-toggle-list">
            {groups.map((group) => (
              <div key={group.category} className="qt-category-group">
                <div className="qt-category-header">
                  <span className="qt-category-icon">
                    {group.category === "Game" ? "🎮" : group.category === "DevTools" ? "🛠" : group.category === "Productivity" ? "📋" : "📦"}
                  </span>
                  <span className="qt-category-label">{group.category}</span>
                  <span className="qt-category-count">{group.entries.length}</span>
                </div>
                {group.entries.map((entry) => {
                  const enabled = !!sessionState?.enabled?.[entry.manifest.id];
                  return (
                    <label key={entry.manifest.id} className="quick-toggle-row">
                      <span className="qt-ext-icon">
                        <MarketplaceExtensionIcon extensionId={entry.manifest.id} />
                      </span>
                      <span className="qt-ext-info">
                        <span className="quick-toggle-name">{entry.manifest.name}</span>
                        <span className="quick-toggle-id">{entry.manifest.description}</span>
                      </span>
                      <span
                        className={`qt-toggle-switch ${enabled ? "qt-toggle-on" : ""}`}
                        onClick={(e) => {
                          e.preventDefault();
                          setSessionEnabled(entry.manifest.id, !enabled);
                        }}
                      >
                        <span className="qt-toggle-knob" />
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && <div className="marketplace-empty">対象拡張がありません。</div>}
          </div>
        </div>
      )}
    </span>
  );
};
