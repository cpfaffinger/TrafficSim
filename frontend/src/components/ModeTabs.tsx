import type { KeyboardEvent } from 'react';

export type AppMode = 'network' | 'ring';

const MODES: { id: AppMode; label: string }[] = [
  { id: 'network', label: 'Network viewer' },
  { id: 'ring', label: 'Ring road demo' },
];

export interface ModeTabsProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

/** Accessible tab list (arrow keys move between tabs). */
export function ModeTabs({ mode, onChange }: ModeTabsProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = MODES.findIndex((m) => m.id === mode);
    const next = MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]!;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <div className="mode-tabs" role="tablist" aria-label="Mode" onKeyDown={onKeyDown}>
      {MODES.map((m) => (
        <button
          key={m.id}
          id={`tab-${m.id}`}
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          aria-controls={`panel-${m.id}`}
          tabIndex={mode === m.id ? 0 : -1}
          className={mode === m.id ? 'active' : undefined}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
