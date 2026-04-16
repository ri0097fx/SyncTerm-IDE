import React, { useState, useCallback, useEffect, useRef } from "react";

type SolitaireCardView = {
  rank: string;
  suitSymbol: string;
  isRed: boolean;
  isDown: boolean;
  isEmpty: boolean;
  raw: string;
};

type Selection =
  | { type: "waste" }
  | { type: "tableau"; col: number; cardIdx: number }
  | null;

type SolState = {
  stock: number;
  waste: string;
  draw: number;
  f: Record<string, number>;
  tab: string[][];
};

function decodeCard(card: string | undefined): SolitaireCardView {
  if (!card || card === "--")
    return { rank: "", suitSymbol: "", isRed: false, isDown: false, isEmpty: true, raw: card ?? "" };
  if (card === "##")
    return { rank: "", suitSymbol: "", isRed: false, isDown: true, isEmpty: false, raw: card };
  const suit = card.slice(-1).toUpperCase();
  const rawRank = card.slice(0, -1).toUpperCase();
  const rank = rawRank === "T" ? "10" : rawRank;
  const suitSymbol = suit === "S" ? "♠" : suit === "H" ? "♥" : suit === "D" ? "♦" : suit === "C" ? "♣" : "?";
  const isRed = suit === "H" || suit === "D";
  return { rank, suitSymbol, isRed, isDown: false, isEmpty: false, raw: card };
}

const FOUNDATION_SUITS = [
  { key: "S", symbol: "♠", color: "black" },
  { key: "H", symbol: "♥", color: "red" },
  { key: "D", symbol: "♦", color: "red" },
  { key: "C", symbol: "♣", color: "black" },
];

const RANK_DISPLAY: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };
function rankLabel(n: number): string { return RANK_DISPLAY[n] ?? String(n); }

interface SolitairePanelProps {
  parsed: SolState;
  msg: string;
  won: boolean;
  runCommand: (cmd: string, args?: unknown[]) => void;
  extId: string;
}

export const SolitaireBoard: React.FC<SolitairePanelProps> = ({ parsed, msg, won, runCommand, extId }) => {
  const [sel, setSel] = useState<Selection>(null);
  const [cursor, setCursor] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);

  const clearSel = useCallback(() => setSel(null), []);

  const handleStock = useCallback(() => {
    clearSel();
    runCommand(`${extId}.draw`);
  }, [extId, runCommand, clearSel]);

  const handleWasteClick = useCallback(() => {
    if (!parsed.waste || parsed.waste === "--") return;
    if (sel?.type === "waste") {
      clearSel();
      return;
    }
    setSel({ type: "waste" });
  }, [sel, parsed.waste, clearSel]);

  const handleWasteDbl = useCallback(() => {
    if (!parsed.waste || parsed.waste === "--") return;
    clearSel();
    runCommand(`${extId}.wf`);
  }, [extId, parsed.waste, runCommand, clearSel]);

  const handleFoundation = useCallback((suitKey: string) => {
    if (!sel) return;
    if (sel.type === "waste") {
      runCommand(`${extId}.wf`);
    } else if (sel.type === "tableau") {
      runCommand(`${extId}.tf`, [sel.col]);
    }
    clearSel();
  }, [sel, extId, runCommand, clearSel]);

  const handleTableauClick = useCallback((colIdx: number, cardIdx: number, isDown: boolean) => {
    if (isDown) return;

    if (sel) {
      if (sel.type === "tableau" && sel.col === colIdx) {
        clearSel();
        return;
      }
      if (sel.type === "waste") {
        runCommand(`${extId}.wt`, [colIdx]);
      } else if (sel.type === "tableau") {
        runCommand(`${extId}.tt`, [sel.col, colIdx]);
      }
      clearSel();
      return;
    }

    setSel({ type: "tableau", col: colIdx, cardIdx });
    setCursor(colIdx);
  }, [sel, extId, runCommand, clearSel]);

  const handleTableauEmpty = useCallback((colIdx: number) => {
    if (!sel) return;
    if (sel.type === "waste") {
      runCommand(`${extId}.wt`, [colIdx]);
    } else if (sel.type === "tableau") {
      runCommand(`${extId}.tt`, [sel.col, colIdx]);
    }
    clearSel();
  }, [sel, extId, runCommand, clearSel]);

  const handleTableauDbl = useCallback((colIdx: number) => {
    clearSel();
    runCommand(`${extId}.tf`, [colIdx]);
  }, [extId, runCommand, clearSel]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const key = e.key;
      if (key === "Escape") { e.preventDefault(); clearSel(); return; }
      if (key.toLowerCase() === "d") { e.preventDefault(); clearSel(); runCommand(`${extId}.draw`); return; }
      if (key.toLowerCase() === "n") { e.preventDefault(); clearSel(); runCommand(`${extId}.new`); return; }
      if (key.toLowerCase() === "m") { e.preventDefault(); runCommand(`${extId}.drawMode`); return; }

      if (key === "ArrowLeft") {
        e.preventDefault();
        setCursor(c => Math.max(0, c - 1));
        return;
      }
      if (key === "ArrowRight") {
        e.preventDefault();
        setCursor(c => Math.min(6, c + 1));
        return;
      }

      if (key.toLowerCase() === "w") {
        e.preventDefault();
        if (sel?.type === "waste") { clearSel(); } else { setSel({ type: "waste" }); }
        return;
      }

      if (key.toLowerCase() === "f") {
        e.preventDefault();
        if (sel) {
          if (sel.type === "waste") runCommand(`${extId}.wf`);
          else if (sel.type === "tableau") runCommand(`${extId}.tf`, [sel.col]);
          clearSel();
        }
        return;
      }

      if (/^[1-7]$/.test(key)) {
        e.preventDefault();
        const col = Number(key) - 1;
        if (sel) {
          if (sel.type === "waste") runCommand(`${extId}.wt`, [col]);
          else if (sel.type === "tableau" && sel.col !== col) runCommand(`${extId}.tt`, [sel.col, col]);
          clearSel();
        } else {
          const tabCol = parsed.tab?.[col];
          if (tabCol && tabCol.length > 0) {
            const faceUpIdx = tabCol.findIndex(c => c !== "##");
            if (faceUpIdx >= 0) setSel({ type: "tableau", col, cardIdx: faceUpIdx });
          }
          setCursor(col);
        }
        return;
      }

      if (key === "Enter" || key === " ") {
        e.preventDefault();
        if (sel) {
          if (sel.type === "waste") runCommand(`${extId}.wt`, [cursor]);
          else if (sel.type === "tableau" && sel.col !== cursor) runCommand(`${extId}.tt`, [sel.col, cursor]);
          clearSel();
        } else {
          const tabCol = parsed.tab?.[cursor];
          if (tabCol && tabCol.length > 0) {
            const faceUpIdx = tabCol.findIndex(c => c !== "##");
            if (faceUpIdx >= 0) setSel({ type: "tableau", col: cursor, cardIdx: faceUpIdx });
          }
        }
        return;
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [sel, cursor, extId, runCommand, clearSel, parsed.tab]);

  const wasteCard = decodeCard(parsed.waste);
  const tab = parsed.tab || [];

  const isSelected = (type: string, col?: number) => {
    if (!sel) return false;
    if (type === "waste") return sel.type === "waste";
    if (type === "tableau" && col !== undefined) return sel.type === "tableau" && sel.col === col;
    return false;
  };

  return (
    <div
      className="game-sol-board"
      ref={boardRef}
      tabIndex={0}
      onClick={(e) => { if (e.target === e.currentTarget) clearSel(); }}
    >
      {won && <div className="game-sol-win">🎉 You Win!</div>}
      <div className="game-sol-msg">{msg}</div>

      {/* Top row: Stock, Waste, gap, Foundations */}
      <div className="game-sol-top-row">
        <div
          className={`game-sol-slot game-sol-stock ${parsed.stock === 0 ? "game-sol-slot-empty" : ""}`}
          onClick={handleStock}
          title="Click to draw (D)"
        >
          {parsed.stock > 0 ? (
            <div className="game-sol-card-back">
              <span className="game-sol-stock-count">{parsed.stock}</span>
            </div>
          ) : (
            <span className="game-sol-recycle">↻</span>
          )}
        </div>

        <div
          className={`game-sol-slot game-sol-waste-slot ${isSelected("waste") ? "game-sol-selected" : ""}`}
          onClick={handleWasteClick}
          onDoubleClick={handleWasteDbl}
          title="Click to select, double-click to move to foundation (W)"
        >
          {wasteCard.isEmpty ? (
            <span className="game-sol-empty-label">Waste</span>
          ) : (
            <div className={`game-sol-card-face ${wasteCard.isRed ? "game-sol-face-red" : "game-sol-face-black"}`}>
              <span className="game-sol-card-rank">{wasteCard.rank}</span>
              <span className="game-sol-card-suit">{wasteCard.suitSymbol}</span>
            </div>
          )}
        </div>

        <div className="game-sol-spacer" />

        {FOUNDATION_SUITS.map(fs => (
          <div
            key={fs.key}
            className={`game-sol-slot game-sol-foundation ${sel ? "game-sol-droppable" : ""}`}
            onClick={() => handleFoundation(fs.key)}
            title={`Foundation ${fs.symbol} (F)`}
          >
            {(parsed.f?.[fs.key] ?? 0) > 0 ? (
              <div className={`game-sol-card-face ${fs.color === "red" ? "game-sol-face-red" : "game-sol-face-black"}`}>
                <span className="game-sol-card-rank">{rankLabel(parsed.f[fs.key])}</span>
                <span className="game-sol-card-suit">{fs.symbol}</span>
              </div>
            ) : (
              <span className={`game-sol-empty-suit ${fs.color === "red" ? "game-sol-face-red" : "game-sol-face-black"}`} style={{opacity:0.3}}>{fs.symbol}</span>
            )}
          </div>
        ))}
      </div>

      {/* Tableau */}
      <div className="game-sol-tableau">
        {tab.map((col, colIdx) => (
          <div
            key={`col-${colIdx}`}
            className={`game-sol-tab-col ${cursor === colIdx ? "game-sol-cursor-col" : ""}`}
          >
            <div className="game-sol-tab-label">
              {colIdx + 1}
            </div>
            {col.length === 0 ? (
              <div
                className={`game-sol-slot game-sol-tab-empty ${sel ? "game-sol-droppable" : ""}`}
                onClick={() => handleTableauEmpty(colIdx)}
              />
            ) : (
              <div className="game-sol-tab-stack">
                {col.map((c, ci) => {
                  const card = decodeCard(c);
                  const isSelectedCard = sel?.type === "tableau" && sel.col === colIdx && ci >= sel.cardIdx;
                  return (
                    <div
                      key={`c-${colIdx}-${ci}`}
                      className={`game-sol-tab-card ${card.isDown ? "game-sol-tab-down" : "game-sol-tab-up"} ${isSelectedCard ? "game-sol-selected" : ""} ${!card.isDown && sel && !(sel.type === "tableau" && sel.col === colIdx) ? "game-sol-droppable" : ""}`}
                      style={{ marginTop: ci === 0 ? 0 : card.isDown ? "-2.8rem" : "-2.2rem", zIndex: ci + 1 }}
                      onClick={(e) => { e.stopPropagation(); handleTableauClick(colIdx, ci, card.isDown); }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (!card.isDown && ci === col.length - 1) handleTableauDbl(colIdx);
                      }}
                    >
                      {card.isDown ? (
                        <div className="game-sol-card-back-sm" />
                      ) : (
                        <div className={`game-sol-card-face ${card.isRed ? "game-sol-face-red" : "game-sol-face-black"}`}>
                          <span className="game-sol-card-rank">{card.rank}</span>
                          <span className="game-sol-card-suit">{card.suitSymbol}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="game-sol-help">
        <span>Click: Select → Click destination</span>
        <span>DblClick: → Foundation</span>
        <span>D:Draw W:Waste F:Foundation 1-7:Column N:New</span>
      </div>
    </div>
  );
};
