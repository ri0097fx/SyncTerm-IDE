import React, { useEffect, useRef, useState } from "react";

interface PanelSettingsDropdownProps {
  isDockedToEditor: boolean;
  onToggleDock: () => void;
}

export const PanelSettingsDropdown: React.FC<PanelSettingsDropdownProps> = ({
  isDockedToEditor,
  onToggleDock,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <span className="ext-panel-settings-wrap" ref={wrapRef}>
      <button
        className="ext-panel-settings-btn"
        onClick={() => setOpen((v) => !v)}
        title="Panel settings"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>
      {open && (
        <div className="ext-panel-settings-dropdown">
          <button
            className="ext-panel-settings-item"
            onClick={() => {
              onToggleDock();
              setOpen(false);
            }}
          >
            {isDockedToEditor ? (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
                  <line x1="9" y1="2" x2="9" y2="14" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M5.5 6.5L3.5 8l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>{" "}
                Move to Preview
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
                  <line x1="9" y1="2" x2="9" y2="14" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M5 6.5L7 8l-2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>{" "}
                Move to Editor
              </>
            )}
          </button>
        </div>
      )}
    </span>
  );
};
