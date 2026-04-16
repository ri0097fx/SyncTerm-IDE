import React from "react";
import { useExtensionRuntime } from "./ExtensionRuntimeContext";

interface ExtensionCommandPaletteModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExtensionCommandPaletteModal: React.FC<ExtensionCommandPaletteModalProps> = ({
  open,
  onClose
}) => {
  const { commands, runCommand, lastCommandMessage } = useExtensionRuntime();
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) => `${cmd.title} ${cmd.command} ${cmd.extensionId}`.toLowerCase().includes(q));
  }, [commands, query]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card command-palette-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Extension Commands</h3>
        <input
          className="modal-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search command..."
        />
        <div className="command-palette-list">
          {filtered.map((cmd) => (
            <button
              key={cmd.command}
              className="command-palette-item"
              onClick={() => {
                runCommand(cmd.command);
                onClose();
              }}
            >
              <div className="command-palette-title">{cmd.title}</div>
              <div className="command-palette-sub">
                {cmd.command} · {cmd.extensionId}
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div className="command-palette-empty">一致するコマンドがありません。</div>}
        </div>
        {lastCommandMessage && <div className="command-palette-message">{lastCommandMessage}</div>}
        <div className="modal-actions">
          <button className="primary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
