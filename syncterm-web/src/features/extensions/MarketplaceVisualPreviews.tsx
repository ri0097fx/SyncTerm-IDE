import React from "react";
import type { ExtensionManifest } from "../../types/domain";

function tilePow2048(v: number): number {
  if (v <= 0) return 0;
  let n = 0;
  let x = v;
  while (x > 1 && n < 24) {
    x /= 2;
    n += 1;
  }
  return n;
}

/* --- アイコン（拡張IDごとにSVG） --- */
export const MarketplaceExtensionIcon: React.FC<{ extensionId: string }> = ({ extensionId }) => {
  const uid = React.useId().replace(/:/g, "");
  const common = { width: "100%", height: "100%", viewBox: "0 0 32 32" as const, "aria-hidden": true as const };
  switch (extensionId) {
    case "game.puzzle-2048-lite":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1c1917" />
          <rect x="3" y="3" width="12" height="12" rx="2" fill="#eee4da" />
          <rect x="17" y="3" width="12" height="12" rx="2" fill="#f2b179" />
          <rect x="3" y="17" width="12" height="12" rx="2" fill="#edc22e" />
          <rect x="17" y="17" width="12" height="12" rx="2" fill="#f67c5f" />
          <text x="6.5" y="11.5" fontSize="7" fill="#776e65" fontWeight="700">
            2
          </text>
          <text x="20" y="11.5" fontSize="7" fill="#f9f6f2" fontWeight="700">
            4
          </text>
          <text x="6" y="25.5" fontSize="7" fill="#f9f6f2" fontWeight="700">
            8
          </text>
          <text x="19" y="25.5" fontSize="7" fill="#f9f6f2" fontWeight="700">
            16
          </text>
        </svg>
      );
    case "game.arcade-snake-lite":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <rect x="18" y="14" width="10" height="5" rx="1" fill="#16a34a" />
          <rect x="10" y="14" width="7" height="5" rx="1" fill="#22c55e" />
          <circle cx="24" cy="16.5" r="2.2" fill="#f43f5e" />
        </svg>
      );
    case "game.board-othello-mini":
      return (
        <svg {...common}>
          <defs>
            <radialGradient id={`${uid}-ot-b`} cx="35%" cy="35%">
              <stop offset="0%" stopColor="#6b7280" />
              <stop offset="100%" stopColor="#020617" />
            </radialGradient>
            <radialGradient id={`${uid}-ot-w`} cx="35%" cy="35%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="100%" stopColor="#9ca3af" />
            </radialGradient>
          </defs>
          <rect width="32" height="32" rx="8" fill="#15803d" />
          <circle cx="12" cy="16" r="7" fill={`url(#${uid}-ot-b)`} />
          <circle cx="22" cy="16" r="7" fill={`url(#${uid}-ot-w)`} />
        </svg>
      );
    case "game.word-wordsprint":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1e293b" />
          <rect x="4" y="8" width="6" height="8" rx="1" fill="#334155" stroke="#94a3b8" strokeWidth="0.5" />
          <rect x="13" y="8" width="6" height="8" rx="1" fill="#334155" stroke="#94a3b8" strokeWidth="0.5" />
          <rect x="22" y="8" width="6" height="8" rx="1" fill="#4f46e5" stroke="#a5b4fc" strokeWidth="0.5" />
          <text x="5" y="14.5" fontSize="6" fill="#f8fafc" fontWeight="800">
            A
          </text>
          <text x="14" y="14.5" fontSize="6" fill="#f8fafc" fontWeight="800">
            B
          </text>
          <text x="23" y="14.5" fontSize="6" fill="#eef2ff" fontWeight="800">
            ?
          </text>
        </svg>
      );
    case "game.puzzle-tetris":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#020617" />
          <rect x="4" y="6" width="24" height="4" rx="0.5" fill="#00bcd4" opacity="0.9" />
          <rect x="10" y="12" width="8" height="8" rx="0.5" fill="#fbc02d" />
          <rect x="10" y="20" width="4" height="4" fill="#ab47bc" />
          <rect x="14" y="20" width="4" height="4" fill="#ab47bc" />
          <rect x="18" y="20" width="4" height="4" fill="#ab47bc" />
          <rect x="14" y="24" width="4" height="4" fill="#ab47bc" />
        </svg>
      );
    case "game.puzzle-minesweeper":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          {[0, 1, 2].map((r) =>
            [0, 1, 2].map((c) => (
              <rect key={`${r}-${c}`} x={6 + c * 7} y={6 + r * 7} width="6" height="6" rx="1" fill="#334155" stroke="#64748b" strokeWidth="0.4" />
            ))
          )}
          <text x="12.5" y="17.5" fontSize="8" fontWeight="800" fill="#f59e0b">
            ⚑
          </text>
        </svg>
      );
    case "game.puzzle-sudoku-pro":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <rect x="5" y="5" width="22" height="22" fill="none" stroke="#94a3b8" strokeWidth="1" />
          <line x1="12.3" y1="5" x2="12.3" y2="27" stroke="#64748b" strokeWidth="0.7" />
          <line x1="19.6" y1="5" x2="19.6" y2="27" stroke="#64748b" strokeWidth="0.7" />
          <line x1="5" y1="12.3" x2="27" y2="12.3" stroke="#64748b" strokeWidth="0.7" />
          <line x1="5" y1="19.6" x2="27" y2="19.6" stroke="#64748b" strokeWidth="0.7" />
          <text x="8.4" y="11.2" fontSize="5" fill="#fbbf24" fontWeight="700">5</text>
          <text x="16.1" y="18.8" fontSize="5" fill="#38bdf8" fontWeight="700">3</text>
        </svg>
      );
    case "game.board-chess-pro":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#334155" />
          <rect x="5" y="5" width="22" height="22" fill="#cbd5e1" />
          <rect x="5" y="5" width="11" height="11" fill="#64748b" />
          <rect x="16" y="16" width="11" height="11" fill="#64748b" />
          <text x="9.2" y="23" fontSize="10" fill="#0f172a">♘</text>
          <text x="18.5" y="15.3" fontSize="10" fill="#f8fafc">♛</text>
        </svg>
      );
    case "game.board-shogi-lite":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#f59e0b" />
          <rect x="5" y="5" width="22" height="22" fill="#fcd34d" stroke="#b45309" strokeWidth="0.7" />
          <text x="10" y="16" fontSize="8" fill="#1f2937" fontWeight="700">飛</text>
          <text x="16.8" y="24" fontSize="8" fill="#1f2937" fontWeight="700">王</text>
        </svg>
      );
    case "game.puzzle-puyo-burst":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <circle cx="10" cy="11" r="5" fill="#ef4444" />
          <circle cx="18.5" cy="12" r="5" fill="#3b82f6" />
          <circle cx="14.5" cy="20.5" r="5" fill="#22c55e" />
        </svg>
      );
    case "game.card-solitaire-klondike":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f766e" />
          <rect x="5" y="8" width="10" height="14" rx="1.5" fill="#f8fafc" />
          <rect x="17" y="10" width="10" height="14" rx="1.5" fill="#e2e8f0" />
          <text x="8" y="18.5" fontSize="8" fill="#dc2626" fontWeight="700">A♥</text>
        </svg>
      );
    case "game.board-connect-four":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0b1530" />
          <rect x="5" y="6" width="22" height="20" rx="3" fill="#1e3a8a" />
          {[0,1,2,3].map((c) => <circle key={`c4-top-${c}`} cx={8 + c * 5.2} cy="11" r="1.8" fill="#f59e0b" />)}
          {[0,1,2,3].map((c) => <circle key={`c4-mid-${c}`} cx={8 + c * 5.2} cy="17" r="1.8" fill={c % 2 ? "#dc2626" : "#f59e0b"} />)}
          {[0,1,2,3].map((c) => <circle key={`c4-bot-${c}`} cx={8 + c * 5.2} cy="22.8" r="1.8" fill={c % 2 ? "#f59e0b" : "#dc2626"} />)}
        </svg>
      );
    case "devtools.json-lab":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <path d="M8 10h16v2H8zm0 5h10v2H8zm0 5h14v2H8z" fill="#64748b" />
          <path d="M8 10h3v2H8zm0 5h3v2H8zm0 5h3v2H8z" fill="#38bdf8" />
          <text x="22" y="13" fontSize="5" fill="#a78bfa" fontFamily="monospace">
            {"{}"}
          </text>
        </svg>
      );
    case "devtools.regex-lab":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1e1b4b" />
          <rect x="5" y="11" width="22" height="10" rx="2" fill="#312e81" stroke="#818cf8" strokeWidth="0.6" />
          <text x="7" y="18.5" fontSize="6" fill="#e0e7ff" fontFamily="monospace">
            .*
          </text>
        </svg>
      );
    case "devtools.diff-notes":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#fefce8" />
          <rect x="7" y="8" width="18" height="3" rx="0.5" fill="#fde047" />
          <rect x="7" y="14" width="14" height="2" rx="0.5" fill="#cbd5e1" />
          <rect x="7" y="19" width="16" height="2" rx="0.5" fill="#cbd5e1" />
          <rect x="7" y="24" width="12" height="2" rx="0.5" fill="#cbd5e1" />
        </svg>
      );
    case "devtools.api-status":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <circle cx="10" cy="16" r="4" fill="#22c55e" />
          <rect x="16" y="12" width="12" height="8" rx="2" fill="#1e293b" stroke="#334155" strokeWidth="0.5" />
          <text x="17.5" y="17.5" fontSize="5" fill="#94a3b8">
            OK
          </text>
        </svg>
      );
    case "productivity.pomodoro":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="12" fill="#1e293b" stroke="#f97316" strokeWidth="2.5" />
          <path d="M16 16 L16 8" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" />
          <text x="10" y="19" fontSize="6" fill="#e2e8f0" fontWeight="700">
            25
          </text>
        </svg>
      );
    case "productivity.kanban-lite":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#f1f5f9" />
          <rect x="3" y="6" width="8" height="20" rx="1" fill="#e2e8f0" />
          <rect x="12" y="6" width="8" height="20" rx="1" fill="#e2e8f0" />
          <rect x="21" y="6" width="8" height="20" rx="1" fill="#dcfce7" />
          <rect x="4" y="8" width="6" height="3" rx="0.5" fill="#94a3b8" />
          <rect x="13" y="8" width="6" height="3" rx="0.5" fill="#60a5fa" />
          <rect x="22" y="8" width="6" height="3" rx="0.5" fill="#4ade80" />
        </svg>
      );
    case "productivity.scratchpad":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#fffbeb" />
          <line x1="6" y1="10" x2="26" y2="10" stroke="#fcd34d" strokeWidth="0.4" />
          <line x1="6" y1="14" x2="26" y2="14" stroke="#fcd34d" strokeWidth="0.4" />
          <line x1="6" y1="18" x2="22" y2="18" stroke="#fcd34d" strokeWidth="0.4" />
          <line x1="6" y1="22" x2="26" y2="22" stroke="#fcd34d" strokeWidth="0.4" />
          <line x1="6" y1="26" x2="20" y2="26" stroke="#fcd34d" strokeWidth="0.4" />
        </svg>
      );
    case "productivity.habit-tracker":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <text x="10" y="22" fontSize="14" fill="#fbbf24" fontWeight="800">
            +1
          </text>
        </svg>
      );
    case "productivity.calendar-planner":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1e293b" />
          <rect x="6" y="8" width="20" height="17" rx="2" fill="#e2e8f0" />
          <rect x="6" y="8" width="20" height="4" rx="2" fill="#3b82f6" />
          <rect x="10" y="15" width="4" height="4" fill="#60a5fa" />
        </svg>
      );
    case "productivity.goal-tracker-pro":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#111827" />
          <rect x="7" y="20" width="4" height="5" fill="#60a5fa" />
          <rect x="14" y="16" width="4" height="9" fill="#34d399" />
          <rect x="21" y="11" width="4" height="14" fill="#f59e0b" />
        </svg>
      );
    case "productivity.time-blocker":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#0f172a" />
          <rect x="7" y="8" width="18" height="4" rx="1" fill="#3b82f6" />
          <rect x="7" y="14" width="14" height="4" rx="1" fill="#14b8a6" />
          <rect x="7" y="20" width="10" height="4" rx="1" fill="#f97316" />
        </svg>
      );
    case "productivity.weekly-review":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1f2937" />
          <path d="M7 10h18M7 15h18M7 20h14" stroke="#cbd5e1" strokeWidth="1.2" />
          <circle cx="24" cy="20" r="3" fill="#22c55e" />
        </svg>
      );
    case "productivity.meeting-notes":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#fffbeb" />
          <rect x="8" y="7" width="16" height="19" rx="2" fill="#fff" stroke="#f59e0b" strokeWidth="0.8" />
          <path d="M11 12h10M11 16h10M11 20h7" stroke="#94a3b8" strokeWidth="0.8" />
        </svg>
      );
    case "productivity.notion-notes":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#1e1e1e" />
          <rect x="6" y="5" width="20" height="22" rx="3" fill="#2d2d2d" stroke="#555" strokeWidth="0.5" />
          <path d="M10 10h12" stroke="#e2e8f0" strokeWidth="1.2" />
          <path d="M10 14h10" stroke="#94a3b8" strokeWidth="0.7" />
          <rect x="10" y="17" width="2" height="2" rx="0.5" fill="#3b82f6" />
          <path d="M14 18h6" stroke="#94a3b8" strokeWidth="0.7" />
          <rect x="10" y="21" width="2" height="2" rx="0.5" fill="#22c55e" />
          <path d="M14 22h5" stroke="#94a3b8" strokeWidth="0.7" />
        </svg>
      );
    case "productivity.paper-manager":
      return (
        <svg {...common}>
          <defs><linearGradient id={`pm${uid}`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#1e3a5f" /><stop offset="100%" stopColor="#0f172a" /></linearGradient></defs>
          <rect width="32" height="32" rx="8" fill={`url(#pm${uid})`} />
          <rect x="7" y="4" width="18" height="24" rx="2" fill="#fff" fillOpacity="0.1" stroke="#60a5fa" strokeWidth="0.6" />
          <path d="M10 9h12M10 13h10M10 17h8" stroke="#94a3b8" strokeWidth="0.6" />
          <text x="10" y="24" fontSize="5" fill="#f59e0b" fontWeight="700">★★★★★</text>
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="8" fill="#334155" />
          <rect x="8" y="8" width="16" height="16" rx="3" fill="none" stroke="#94a3b8" strokeWidth="1.2" />
          <path d="M12 20l4-8 4 8" stroke="#cbd5e1" strokeWidth="1" fill="none" />
        </svg>
      );
  }
};

/* --- プレイ画面風プレビュー --- */
const DEMO_2048 = [
  [2, 4, 8, 16],
  [4, 8, 0, 2],
  [0, 0, 4, 2],
  [0, 0, 0, 4]
];

const DEMO_SNAKE: number[][] = (() => {
  const W = 12;
  const H = 12;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  const snake = [
    [6, 6],
    [5, 6],
    [4, 6]
  ];
  snake.forEach(([x, y], i) => {
    g[y][x] = i === 0 ? 2 : 3;
  });
  g[6][9] = 1;
  return g;
})();

const DEMO_OTHELLO =
  "...........................BW......WB...........................";

const DEMO_MS =
  "HHHHHHHHH" +
  "HHHHHHHHH" +
  "HHH12FHHH" +
  "HHH000HHH" +
  "HHHH0HHHH" +
  "HHHHHHHHH" +
  "HHHHHHHHH" +
  "HHHHHHHHH" +
  "HHHHHHHHH";

function Mini2048() {
  return (
    <div className="marketplace-surface marketplace-surface--2048">
      <div className="game-board-2048">
        {DEMO_2048.map((row, rIdx) => (
          <div key={rIdx} className="game-board-2048-row">
            {row.map((v, cIdx) => (
              <div
                key={cIdx}
                className={
                  v === 0 ? "game-tile-2048 game-tile-2048-empty" : `game-tile-2048 game-tile-2048-pow-${Math.min(tilePow2048(v), 16)}`
                }
              >
                {v > 0 ? String(v) : ""}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniSnake() {
  return (
    <div className="marketplace-surface marketplace-surface--snake">
      <div className="game-snake-wrap">
        <div className="game-snake-dir" aria-hidden>
          →
        </div>
        <div className="game-board-snake">
          {DEMO_SNAKE.map((row, rIdx) => (
            <div key={rIdx} className="game-board-snake-row">
              {row.map((cell, cIdx) => {
                const showNext = rIdx === 6 && cIdx === 7;
                const cls = [
                  "game-snake-cell",
                  cell === 1 ? "game-snake-food" : "",
                  cell === 2 ? "game-snake-head" : "",
                  cell === 3 ? "game-snake-body" : "",
                  cell === 0 ? "game-snake-empty" : "",
                  showNext ? "game-snake-next" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                return <span key={cIdx} className={cls} />;
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniOthello() {
  const cells = DEMO_OTHELLO.split("");
  return (
    <div className="marketplace-surface marketplace-surface--othello">
      <div className="game-board-othello">
        {Array.from({ length: 8 }).map((_, r) => (
          <div key={r} className="game-board-othello-row">
            {Array.from({ length: 8 }).map((__, c) => {
              const ch = cells[r * 8 + c] ?? ".";
              const disc = ch === "B" ? "black" : ch === "W" ? "white" : null;
              const isHint = r === 2 && c === 2 && !disc;
              return (
                <div key={c} className={`game-othello-cell ${isHint ? "game-othello-legal" : ""}`}>
                  {disc ? <span className={`game-othello-disc game-othello-disc-${disc}`} /> : null}
                  {isHint ? <span className="game-othello-hint" /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniWordSprint() {
  const scramble = "tmeinral";
  const choices = ["terminal", "runtime", "session"];
  return (
    <div className="marketplace-surface marketplace-surface--word">
      <div className="game-word-sprint">
        <div className="game-word-label">並び替え</div>
        <div className="game-word-scramble">
          {scramble.split("").map((ch, i) => (
            <span key={i} className="game-word-chip">
              {ch}
            </span>
          ))}
        </div>
        <div className="game-word-label">正解を選ぶ</div>
        <div className="game-word-choices">
          {choices.map((word, idx) => (
            <div key={word} className="game-word-choice-btn marketplace-surface--fake-btn" aria-hidden>
              <span className="game-word-choice-idx">{idx + 1}</span>
              <span className="game-word-choice-text">{word}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniTetris() {
  const W = 10;
  const H = 12;
  const locked = Array.from({ length: H }, () => Array(W).fill(0));
  for (let c = 0; c < W; c += 1) locked[H - 1][c] = 7;
  for (let c = 0; c < 6; c += 1) locked[H - 2][c] = 6;
  const piece = Array.from({ length: H }, () => Array(W).fill(0));
  piece[2][4] = piece[2][5] = piece[2][6] = piece[3][5] = 3;
  const ghost = Array.from({ length: H }, () => Array(W).fill(0));
  for (let c = 3; c <= 5; c += 1) ghost[H - 3][c] = 3;
  return (
    <div className="marketplace-surface marketplace-surface--tetris">
      <div className="tetris-runtime">
        <div className="tetris-board">
          {locked.map((row, rIdx) => (
            <div key={rIdx} className="tetris-row">
              {row.map((v, cIdx) => {
                const p = piece[rIdx][cIdx];
                const g = ghost[rIdx][cIdx];
                const solid = p || v;
                const ghostOnly = !solid && g;
                const cls = [
                  "tetris-cell",
                  solid ? `tetris-cell-solid tetris-cell-${solid}` : "",
                  ghostOnly ? `tetris-cell-ghost tetris-cell-${g}` : "",
                  !solid && !ghostOnly ? "tetris-cell-0" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                return <span key={cIdx} className={cls} />;
              })}
            </div>
          ))}
        </div>
        <div className="tetris-side">
          <div className="tetris-mini-block">
            <div className="tetris-mini-title">HOLD</div>
            <div className="tetris-mini-shape">
              <div className="tetris-row">
                <span className="tetris-cell tetris-cell-solid tetris-cell-1" />
                <span className="tetris-cell tetris-cell-solid tetris-cell-1" />
                <span className="tetris-cell tetris-cell-solid tetris-cell-1" />
                <span className="tetris-cell tetris-cell-solid tetris-cell-1" />
              </div>
            </div>
          </div>
          <div className="tetris-mini-block">
            <div className="tetris-mini-title">NEXT</div>
            {[2, 5, 6, 4].map((id, idx) => (
              <div key={idx} className="tetris-next-item">
                <div className="tetris-mini-name">
                  {idx + 1}. {id === 2 ? "O" : id === 5 ? "J" : id === 6 ? "S" : "L"}
                </div>
                <div className="tetris-mini-shape">
                  {id === 2 ? (
                    <>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-2" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-2" />
                      </div>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-2" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-2" />
                      </div>
                    </>
                  ) : null}
                  {id === 5 ? (
                    <>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-5" />
                        <span className="tetris-cell tetris-cell-0" />
                        <span className="tetris-cell tetris-cell-0" />
                      </div>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-5" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-5" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-5" />
                      </div>
                    </>
                  ) : null}
                  {id === 6 ? (
                    <>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-0" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-6" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-6" />
                      </div>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-6" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-6" />
                        <span className="tetris-cell tetris-cell-0" />
                      </div>
                    </>
                  ) : null}
                  {id === 4 ? (
                    <>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-0" />
                        <span className="tetris-cell tetris-cell-0" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-4" />
                      </div>
                      <div className="tetris-row">
                        <span className="tetris-cell tetris-cell-solid tetris-cell-4" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-4" />
                        <span className="tetris-cell tetris-cell-solid tetris-cell-4" />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniMinesweeper() {
  const cx = 4;
  const cy = 2;
  const rows: string[][] = [];
  for (let y = 0; y < 9; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < 9; x += 1) row.push(DEMO_MS[y * 9 + x] ?? "H");
    rows.push(row);
  }
  return (
    <div className="marketplace-surface marketplace-surface--mines">
      <div className="game-board-minesweeper">
        {rows.map((row, rIdx) => (
          <div key={rIdx} className="game-board-minesweeper-row">
            {row.map((cell, cIdx) => {
              const cursor = cx === cIdx && cy === rIdx;
              const num = /^[1-8]$/.test(cell) ? cell : "";
              const cls = [
                "game-ms-cell",
                cell === "H" ? "game-ms-hidden" : "",
                cell === "F" ? "game-ms-flag" : "",
                cell === "M" ? "game-ms-mine" : "",
                cell === "0" ? "game-ms-open0" : "",
                num ? `game-ms-n${num}` : "",
                cursor ? "game-ms-cursor" : ""
              ]
                .filter(Boolean)
                .join(" ");
              let label = "";
              if (cell === "F") label = "⚑";
              else if (cell === "M") label = "✹";
              else if (num) label = cell;
              return (
                <span key={cIdx} className={cls}>
                  {label}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function FakePaneChrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="marketplace-fake-pane">
      <div className="marketplace-fake-pane-header">{title}</div>
      <div className="marketplace-fake-pane-body">{children}</div>
    </div>
  );
}

function MiniJsonLab() {
  return (
    <FakePaneChrome title="JSON Lab">
      <pre className="marketplace-fake-code">
        <span className="marketplace-fake-k">{"{"}</span>
        {"\n  "}
        <span className="marketplace-fake-key">&quot;name&quot;</span>
        <span className="marketplace-fake-p">: </span>
        <span className="marketplace-fake-str">&quot;sync&quot;</span>
        <span className="marketplace-fake-p">,</span>
        {"\n  "}
        <span className="marketplace-fake-key">&quot;enabled&quot;</span>
        <span className="marketplace-fake-p">: </span>
        <span className="marketplace-fake-bool">true</span>
        {"\n"}
        <span className="marketplace-fake-k">{"}"}</span>
      </pre>
    </FakePaneChrome>
  );
}

function MiniRegexLab() {
  return (
    <FakePaneChrome title="Regex Lab">
      <div className="marketplace-fake-field">
        <span className="marketplace-fake-label">Pattern</span>
        <code className="marketplace-fake-input">^[a-z]+</code>
      </div>
      <div className="marketplace-fake-matches">
        <span className="marketplace-fake-chip">alpha_123</span>
        <span className="marketplace-fake-chip">beta-test</span>
      </div>
    </FakePaneChrome>
  );
}

function MiniDiffNotes() {
  return (
    <FakePaneChrome title="Diff Notes">
      <ul className="marketplace-fake-checklist">
        <li>
          <span className="marketplace-fake-cb" /> API changed
        </li>
        <li>
          <span className="marketplace-fake-cb marketplace-fake-cb--on" /> UI touched
        </li>
        <li>
          <span className="marketplace-fake-cb" /> Add tests
        </li>
      </ul>
    </FakePaneChrome>
  );
}

function MiniApiStatus() {
  return (
    <FakePaneChrome title="API Status">
      <div className="marketplace-fake-cards">
        <div className="marketplace-fake-card marketplace-fake-card--ok">
          <span className="marketplace-fake-dot" /> health
        </div>
        <div className="marketplace-fake-card">
          <span className="marketplace-fake-muted">checkedAt</span>
          <strong>14:25:18</strong>
        </div>
      </div>
    </FakePaneChrome>
  );
}

function MiniPomodoro() {
  return (
    <FakePaneChrome title="Pomodoro">
      <div className="marketplace-fake-pomodoro">
        <div className="marketplace-fake-pomo-ring">
          <span className="marketplace-fake-pomo-time">25:00</span>
        </div>
        <div className="marketplace-fake-pomo-meta">completed: 3</div>
      </div>
    </FakePaneChrome>
  );
}

function MiniKanban() {
  return (
    <FakePaneChrome title="Kanban Lite">
      <div className="marketplace-fake-kanban">
        <div className="marketplace-fake-lane">
          <div className="marketplace-fake-lane-h">TODO</div>
          <div className="marketplace-fake-card-t">Write tests</div>
        </div>
        <div className="marketplace-fake-lane">
          <div className="marketplace-fake-lane-h">DOING</div>
          <div className="marketplace-fake-card-t">Refactor</div>
        </div>
        <div className="marketplace-fake-lane">
          <div className="marketplace-fake-lane-h">DONE</div>
          <div className="marketplace-fake-card-t marketplace-fake-card-t--done">Deploy</div>
        </div>
      </div>
    </FakePaneChrome>
  );
}

function MiniScratchpad() {
  return (
    <FakePaneChrome title="Scratchpad">
      <div className="marketplace-fake-scratch">メモをここに…{"\n"}URL / タスク / 下書き</div>
    </FakePaneChrome>
  );
}

function MiniHabit() {
  return (
    <FakePaneChrome title="Habit Tracker">
      <div className="marketplace-fake-habit">
        <div className="marketplace-fake-habit-score">12</div>
        <div className="marketplace-fake-habit-label">streak points</div>
      </div>
    </FakePaneChrome>
  );
}

function MiniSudoku() {
  return (
    <div className="marketplace-surface">
      <div className="game-board-sudoku">
        {Array.from({ length: 9 }).map((_, y) => (
          <div key={y} className="game-board-sudoku-row">
            {Array.from({ length: 9 }).map((__, x) => {
              const v = (x === 0 && y === 0) ? "5" : (x === 4 && y === 0 ? "7" : (x === 4 && y === 4 ? "3" : ""));
              const cursor = x === 4 && y === 4;
              return <span key={x} className={`game-sudoku-cell ${v ? "game-sudoku-given" : ""} ${cursor ? "game-sudoku-cursor" : ""} ${(x + 1) % 3 === 0 ? "game-sudoku-block-right" : ""} ${(y + 1) % 3 === 0 ? "game-sudoku-block-bottom" : ""}`}>{v}</span>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChess() {
  const files = ["a","b","c","d","e","f","g","h"];
  const row = ["r","n","b","q","k","b","n","r"];
  const row2 = ["p","p","p","p","p","p","p","p"];
  const empty = [".",".",".",".",".",".",".","."];
  const row7 = ["P","P","P","P","P","P","P","P"];
  const row8 = ["R","N","B","Q","K","B","N","R"];
  const rows = [row,row2,empty,empty,empty,empty,row7,row8];
  const pieceText: Record<string, string> = { K:"♔", Q:"♕", R:"♖", B:"♗", N:"♘", P:"♙", k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟", ".":"" };
  return (
    <div className="marketplace-surface">
      <div className="game-chess-shell">
        <div className="game-chess-files">{files.map((f) => <span key={`mini-f-top-${f}`} className="game-chess-file">{f}</span>)}</div>
        <div className="game-board-chess">
          {rows.map((r, y) => (
            <div key={y} className="game-board-chess-row">
              <span className="game-chess-rank">{8 - y}</span>
              {r.map((p, x) => {
                const sideClass = p === "." ? "" : (p === p.toUpperCase() ? "game-chess-piece-white" : "game-chess-piece-black");
                const legal = (x === 4 && y === 4) || (x === 4 && y === 5);
                return (
                  <span key={x} className={`game-chess-cell ${(x + y) % 2 ? "game-chess-dark" : "game-chess-light"} ${x === 4 && y === 6 ? "game-chess-selected" : ""} ${legal ? "game-chess-legal" : ""}`}>
                    <span className={`game-chess-piece ${sideClass}`}>{pieceText[p]}</span>
                  </span>
                );
              })}
              <span className="game-chess-rank">{8 - y}</span>
            </div>
          ))}
        </div>
        <div className="game-chess-files">{files.map((f) => <span key={`mini-f-bottom-${f}`} className="game-chess-file">{f}</span>)}</div>
      </div>
    </div>
  );
}

function MiniShogi() {
  const rows = [
    ["l","n","s","g","k","g","s","n","l"],
    [".","r",".",".",".",".",".","b","."],
    ["p","p","p","p","p","p","p","p","p"],
    [".",".",".",".",".",".",".",".","."],
    [".",".",".",".",".",".",".",".","."],
    [".",".",".",".",".",".",".",".","."],
    ["P","P","P","P","P","P","P","P","P"],
    [".","B",".",".",".",".",".","R","."],
    ["L","N","S","G","K","G","S","N","L"]
  ];
  const pieceText: Record<string, string> = { K:"玉", R:"飛", B:"角", G:"金", S:"銀", N:"桂", L:"香", P:"歩", k:"王", r:"飛", b:"角", g:"金", s:"銀", n:"桂", l:"香", p:"歩", ".":"" };
  const dropKinds = ["P","L","N","S","G","B","R"];
  return (
    <div className="marketplace-surface">
      <div className="game-shogi-hand-row game-shogi-hand-row-top">
        {dropKinds.map((k, idx) => <span key={`w-${k}`} className="game-shogi-hand-piece game-shogi-piece-white">{k}:{idx % 2}</span>)}
      </div>
      <div className="game-board-shogi">
        {rows.map((r, y) => (
          <div key={y} className="game-board-shogi-row">
            {r.map((p, x) => {
              const sideClass = p === "." ? "" : (p === p.toUpperCase() ? "game-shogi-piece-black" : "game-shogi-piece-white");
              return <span key={x} className={`game-shogi-cell ${(x + y) % 2 ? "game-shogi-dark" : "game-shogi-light"} ${sideClass}`}>{pieceText[p]}</span>;
            })}
          </div>
        ))}
      </div>
      <div className="game-shogi-hand-row">
        {dropKinds.map((k, idx) => <span key={`b-${k}`} className="game-shogi-hand-piece game-shogi-piece-black">{k}:{1 + (idx % 3 === 0 ? 1 : 0)}</span>)}
      </div>
    </div>
  );
}

function MiniPuyo() {
  const rows = [
    [0,0,0,0,0,0],[0,0,1,0,0,0],[0,0,1,2,0,0],[0,3,2,2,0,0],[0,3,4,4,0,0],[0,1,1,3,0,0],
    [0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0]
  ];
  return (
    <div className="marketplace-surface">
      <div className="game-board-puyo game-board-puyo-glow">
        {rows.map((r, y) => <div key={y} className="game-board-puyo-row">{r.map((v, x) => <span key={x} className={`game-puyo-cell game-puyo-${v}`} />)}</div>)}
      </div>
    </div>
  );
}

function MiniSolitaire() {
  return (
    <div className="marketplace-surface">
      <div className="game-solitaire-top">
        <div className="game-sol-pile">Stock<strong>24</strong></div>
        <div className="game-sol-pile game-sol-pile--wide">
          Waste
          <div className="game-sol-waste-card-wrap">
            <div className="game-sol-card game-sol-up game-sol-red">
              <span className="game-sol-card-face"><span>Q</span><span>♥</span></span>
            </div>
          </div>
        </div>
        <div className="game-sol-pile">♠<strong>1</strong></div>
        <div className="game-sol-pile">♥<strong>0</strong></div>
        <div className="game-sol-pile">♦<strong>0</strong></div>
        <div className="game-sol-pile">♣<strong>0</strong></div>
      </div>
      <div className="game-solitaire-tableau">
        {Array.from({ length: 7 }).map((_, c) => (
          <div key={c} className="game-sol-col">
            <div className="game-sol-col-title">T{c + 1}</div>
            <div className="game-sol-card game-sol-down">##</div>
            <div className={`game-sol-card game-sol-up ${c % 2 ? "game-sol-black" : "game-sol-red"}`} style={{ marginTop: "-0.55rem" }}>
              <span className="game-sol-card-face"><span>{c % 2 ? "7" : "6"}</span><span>{c % 2 ? "♣" : "♥"}</span></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniConnectFour() {
  const rows = [
    [0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0],
    [0,0,0,2,0,0,0],
    [0,0,1,2,0,0,0],
    [0,1,2,1,0,0,0],
    [2,1,1,2,0,0,0],
  ];
  return (
    <div className="marketplace-surface">
      <div className="game-connect4-wrap">
        <div className="game-connect4-board">
          {rows.map((row, y) => (
            <div key={`mini-c4-${y}`} className="game-connect4-row">
              {row.map((v, x) => (
                <span key={`mini-c4c-${y}-${x}`} className="game-connect4-cell-btn">
                  <span className={`game-connect4-disc ${v === 1 ? "game-connect4-disc-r" : v === 2 ? "game-connect4-disc-y" : "game-connect4-disc-e"}`} />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniCalendar() {
  return (
    <FakePaneChrome title="Calendar Planner">
      <div className="marketplace-fake-card">[ ] 09:30 Standup #1</div>
      <div className="marketplace-fake-card marketplace-fake-card--ok">[x] 13:00 Deep Work #2</div>
    </FakePaneChrome>
  );
}
function MiniGoalTracker() {
  return (
    <FakePaneChrome title="Goal Tracker">
      <div className="marketplace-fake-card">Ship pack 45%</div>
      <div className="marketplace-fake-card">Test AI 20%</div>
      <div className="marketplace-fake-muted">avgProgress: 33%</div>
    </FakePaneChrome>
  );
}
function MiniTimeBlocker() {
  return (
    <FakePaneChrome title="Time Blocker">
      <div className="marketplace-fake-card">09:00-10:30 Code</div>
      <div className="marketplace-fake-card">14:00-15:00 Review</div>
      <div className="marketplace-fake-muted">focusHours: 150m</div>
    </FakePaneChrome>
  );
}
function MiniWeeklyReview() {
  return (
    <FakePaneChrome title="Weekly Review">
      <div className="marketplace-fake-card">Wins / Learns / Next</div>
      <div className="marketplace-fake-muted">Summary: 1 / 1 / 1</div>
    </FakePaneChrome>
  );
}
function MiniMeetingNotes() {
  return (
    <FakePaneChrome title="Meeting Notes">
      <div className="marketplace-fake-card">meeting: Weekly Sync</div>
      <div className="marketplace-fake-card">Agenda / Decisions / Actions</div>
    </FakePaneChrome>
  );
}

function FallbackMock({ lines }: { lines: string[] }) {
  return (
    <pre className="marketplace-visual-mock marketplace-visual-mock--in-card">
      {lines.join("\n")}
    </pre>
  );
}

export const MarketplacePlaySurface: React.FC<{ manifest: ExtensionManifest }> = ({ manifest }) => {
  const id = manifest.id;
  const mock = manifest.previewMock ?? [];

  let inner: React.ReactNode;
  switch (id) {
    case "game.puzzle-2048-lite":
      inner = <Mini2048 />;
      break;
    case "game.arcade-snake-lite":
      inner = <MiniSnake />;
      break;
    case "game.board-othello-mini":
      inner = <MiniOthello />;
      break;
    case "game.word-wordsprint":
      inner = <MiniWordSprint />;
      break;
    case "game.puzzle-tetris":
      inner = <MiniTetris />;
      break;
    case "game.puzzle-minesweeper":
      inner = <MiniMinesweeper />;
      break;
    case "game.puzzle-sudoku-pro":
      inner = <MiniSudoku />;
      break;
    case "game.board-chess-pro":
      inner = <MiniChess />;
      break;
    case "game.board-shogi-lite":
      inner = <MiniShogi />;
      break;
    case "game.puzzle-puyo-burst":
      inner = <MiniPuyo />;
      break;
    case "game.card-solitaire-klondike":
      inner = <MiniSolitaire />;
      break;
    case "game.board-connect-four":
      inner = <MiniConnectFour />;
      break;
    case "devtools.json-lab":
      inner = <MiniJsonLab />;
      break;
    case "devtools.regex-lab":
      inner = <MiniRegexLab />;
      break;
    case "devtools.diff-notes":
      inner = <MiniDiffNotes />;
      break;
    case "devtools.api-status":
      inner = <MiniApiStatus />;
      break;
    case "productivity.pomodoro":
      inner = <MiniPomodoro />;
      break;
    case "productivity.kanban-lite":
      inner = <MiniKanban />;
      break;
    case "productivity.scratchpad":
      inner = <MiniScratchpad />;
      break;
    case "productivity.habit-tracker":
      inner = <MiniHabit />;
      break;
    case "productivity.calendar-planner":
      inner = <MiniCalendar />;
      break;
    case "productivity.goal-tracker-pro":
      inner = <MiniGoalTracker />;
      break;
    case "productivity.time-blocker":
      inner = <MiniTimeBlocker />;
      break;
    case "productivity.weekly-review":
      inner = <MiniWeeklyReview />;
      break;
    case "productivity.meeting-notes":
      inner = <MiniMeetingNotes />;
      break;
    default:
      inner = mock.length ? <FallbackMock lines={mock} /> : null;
  }

  if (!inner) return null;
  return <div className="marketplace-play-surface">{inner}</div>;
};
