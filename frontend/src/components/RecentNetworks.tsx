import { useState } from 'react';
import type { NetworkSummary } from '../api/client';
import { bboxAreaKm2, formatKm2 } from '../lib/area';
import { ringAreaKm2 } from '../lib/polygonArea';

export interface RecentNetworksProps {
  networks: NetworkSummary[];
  disabled: boolean;
  onLoad: (id: string) => void;
  /** Renames an import (#114); omitted = no rename button. */
  onRename?: (id: string, name: string) => void;
  /** Deletes an import with its scenarios (#114); omitted = no delete button. */
  onDelete?: (id: string) => void;
  /** Confirmation prompt (window.confirm in the app). */
  confirm?: (message: string) => boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

export function networkTitle(n: NetworkSummary): string {
  return n.name?.trim() || 'Unnamed import';
}

/** Recently imported networks (#34): load, rename and delete (#114). */
export function RecentNetworks({ networks, disabled, onLoad, onRename, onDelete, confirm = () => true }: RecentNetworksProps) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  if (networks.length === 0) return null;

  const commit = () => {
    if (editing && editing.name.trim().length > 0) onRename?.(editing.id, editing.name.trim());
    setEditing(null);
  };

  return (
    <section aria-label="Recent imports">
      <h2>Recent imports</h2>
      <ul className="result-list recent-list">
        {networks.map((n) => (
          <li key={n.id}>
            {editing?.id === n.id ? (
              <form
                className="rename-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  commit();
                }}
              >
                <input
                  aria-label="Import name"
                  value={editing.name}
                  maxLength={120}
                  autoFocus
                  onChange={(e) => setEditing({ id: n.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                />
                <button type="submit">Save</button>
              </form>
            ) : (
              <button type="button" className="recent-load" onClick={() => onLoad(n.id)} disabled={disabled}>
                <span className="result-label">{networkTitle(n)}</span>
                <span className="result-category">
                  {formatKm2(n.polygon ? ringAreaKm2(n.polygon) : bboxAreaKm2(n.bbox))} km²{n.polygon ? ' (custom shape)' : ''} · {n.stats.links} links ·{' '}
                  {n.stats.signals} signals · {formatDate(n.createdAt)} UTC
                </span>
              </button>
            )}
            <span className="recent-actions">
              {onRename && editing?.id !== n.id && (
                <button type="button" aria-label={`Rename ${networkTitle(n)}`} title="Rename" disabled={disabled} onClick={() => setEditing({ id: n.id, name: n.name ?? '' })}>
                  ✎
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  aria-label={`Delete ${networkTitle(n)}`}
                  title="Delete"
                  disabled={disabled}
                  onClick={() => {
                    if (confirm(`Delete "${networkTitle(n)}" with all its scenarios and runs? This cannot be undone.`)) onDelete(n.id);
                  }}
                >
                  🗑
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
