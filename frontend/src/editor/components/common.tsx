import type { ReactNode } from 'react';
import type { EditIssue } from '../../api/scenarioClient';
import type { LaneTurn } from '../../network/types';

/** Turn markings offered as toggles, with arrow glyphs; other markings are kept when present. */
export const TURN_BUTTONS: { turn: LaneTurn; glyph: string; label: string }[] = [
  { turn: 'reverse', glyph: '↶', label: 'U-turn' },
  { turn: 'left', glyph: '↰', label: 'left' },
  { turn: 'slight_left', glyph: '↖', label: 'slight left' },
  { turn: 'through', glyph: '↑', label: 'through' },
  { turn: 'slight_right', glyph: '↗', label: 'slight right' },
  { turn: 'right', glyph: '↱', label: 'right' },
];

export interface TurnTogglesProps {
  turns: readonly LaneTurn[];
  laneLabel: string;
  disabled?: boolean;
  onChange: (turns: LaneTurn[]) => void;
}

/** Toggle buttons for the turn arrows painted on one lane (#66). */
export function TurnToggles({ turns, laneLabel, disabled, onChange }: TurnTogglesProps) {
  const toggle = (turn: LaneTurn) => onChange(turns.includes(turn) ? turns.filter((t) => t !== turn) : [...turns, turn]);
  return (
    <span className="turn-toggles" role="group" aria-label={`Turn markings of ${laneLabel}`}>
      {TURN_BUTTONS.map((b) => (
        <button
          key={b.turn}
          type="button"
          className="glyph"
          aria-pressed={turns.includes(b.turn)}
          aria-label={b.label}
          title={b.label}
          disabled={disabled}
          onClick={() => toggle(b.turn)}
        >
          {b.glyph}
        </button>
      ))}
    </span>
  );
}

export function EditorSection({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="editor-section" open={open}>
      <summary>{title}</summary>
      <div className="editor-section-body">{children}</div>
    </details>
  );
}

/** Edits the backend skipped (#64 rebase report), shown after previews and failed saves. */
export function IssueList({ issues }: { issues: readonly EditIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="issue-list" role="alert">
      <p>
        {issues.length} edit{issues.length === 1 ? ' was' : 's were'} skipped:
      </p>
      <ul>
        {issues.map((i, k) => (
          <li key={k}>
            {i.operationIndex >= 0 && <span className="muted">#{i.operationIndex + 1} </span>}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
