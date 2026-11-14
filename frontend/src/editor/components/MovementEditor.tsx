import { useMemo, useState } from 'react';
import type { PackageIndex } from '../../network/inspect';
import type { Changeset, EditResult } from '../ops';
import { junctionDiagram } from '../junctionDiagram';
import { armLabel, banMovement, junctionMovements, toggleConnection, withoutMovementEdits, type Movement } from '../movements';
import { setTurns } from '../linkEdits';
import { TurnToggles } from './common';

export interface MovementEditorProps {
  index: PackageIndex;
  nodeId: string;
  changeset: Changeset;
  apply: (build: () => EditResult) => boolean;
  replace: (label: string, changeset: Changeset) => void;
}

interface LaneRef {
  linkId: string;
  laneIndex: number;
}

const words = (s: string) => s.replace(/_/g, ' ');

/**
 * Lane connector editor (#66), TM:PE style: pick an incoming lane dot, then click outgoing lane dots
 * to connect or disconnect them. The list below offers the same with checkboxes, plus turn bans.
 */
export function MovementEditor({ index, nodeId, changeset, apply, replace }: MovementEditorProps) {
  const movements = useMemo(() => junctionMovements(index, nodeId, changeset), [index, nodeId, changeset]);
  const diagram = useMemo(() => junctionDiagram(index, nodeId, movements), [index, nodeId, movements]);
  const [from, setFrom] = useState<LaneRef | null>(null);
  const fromLink = from ? index.links.get(from.linkId) : undefined;
  const fromLane = fromLink?.lanes[from!.laneIndex];
  const targets = new Map(movements.filter((m) => m.fromLink.id === from?.linkId).map((m) => [m.toLink.id, m]));
  const connected = (m: Movement, a: number, b: number) => m.connections.some(([x, y]) => x === a && y === b);

  if (movements.length === 0) return <p className="muted small">No movements at this point.</p>;

  const byIncoming = new Map<string, Movement[]>();
  for (const m of movements) byIncoming.set(m.fromLink.id, [...(byIncoming.get(m.fromLink.id) ?? []), m]);

  return (
    <div className="movement-editor">
      <svg className="junction-diagram" viewBox={`0 0 ${diagram.size} ${diagram.size}`} role="group" aria-label="Junction lane connections">
        {diagram.arms.map((a) => (
          <line key={`${a.incoming ? 'in' : 'out'}-${a.linkId}`} x1={a.from.x} y1={a.from.y} x2={a.to.x} y2={a.to.y} strokeWidth={a.width} className="arm" />
        ))}
        {diagram.connections.map((c) => (
          <path
            key={`${c.movementId}-${c.fromLane}-${c.toLane}`}
            d={c.d}
            className={from && c.fromLink === from.linkId && c.fromLane === from.laneIndex ? 'connection active' : 'connection'}
          />
        ))}
        {diagram.outgoing.map((p) => {
          const m = targets.get(p.linkId);
          const on = m && from ? connected(m, from.laneIndex, p.laneIndex) : false;
          return (
            <circle
              key={`out-${p.linkId}-${p.laneIndex}`}
              cx={p.x}
              cy={p.y}
              r={5}
              className={`dot out${m ? ' target' : ''}${on ? ' on' : ''}`}
              role={m ? 'button' : undefined}
              tabIndex={m ? 0 : undefined}
              aria-label={m ? `${on ? 'Disconnect' : 'Connect'} to lane ${p.laneIndex} ${armLabel(m.toLink, false)}` : undefined}
              aria-pressed={m ? on : undefined}
              onClick={() => m && from && apply(() => toggleConnection(m, from.laneIndex, p.laneIndex))}
              onKeyDown={(e) => {
                if (m && from && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  apply(() => toggleConnection(m, from.laneIndex, p.laneIndex));
                }
              }}
            />
          );
        })}
        {diagram.incoming.map((p) => {
          const selected = from?.linkId === p.linkId && from.laneIndex === p.laneIndex;
          const link = index.links.get(p.linkId)!;
          return (
            <circle
              key={`in-${p.linkId}-${p.laneIndex}`}
              cx={p.x}
              cy={p.y}
              r={5}
              className={`dot in${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Incoming lane ${p.laneIndex} ${armLabel(link, true)}`}
              aria-pressed={selected}
              onClick={() => setFrom(selected ? null : { linkId: p.linkId, laneIndex: p.laneIndex })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setFrom(selected ? null : { linkId: p.linkId, laneIndex: p.laneIndex });
                }
              }}
            />
          );
        })}
      </svg>
      <p className="muted small">
        {from && fromLink ? `Lane ${from.laneIndex} ${armLabel(fromLink, true)}: click outgoing lanes to connect or disconnect.` : 'Click an incoming lane (blue) to edit its connections.'}
      </p>
      {from && fromLink && fromLane && (
        <div className="field-row">
          <span>Arrows on lane {from.laneIndex}:</span>
          <TurnToggles
            turns={fromLane.turns}
            laneLabel={`lane ${from.laneIndex} ${armLabel(fromLink, true)}`}
            onChange={(turns) => apply(() => setTurns({ index, changeset, scope: 'part' }, fromLink, from.laneIndex, turns))}
          />
        </div>
      )}

      {[...byIncoming.entries()].map(([linkId, ms]) => {
        const link = index.links.get(linkId)!;
        return (
          <fieldset key={linkId} className="movement-group">
            <legend>{armLabel(link, true)}</legend>
            {ms.map((m) => (
              <div key={m.id} className={`movement${m.banned ? ' banned' : ''}`}>
                <div className="movement-head">
                  <span>
                    {words(m.turn)} {armLabel(m.toLink, false)}
                    {m.banned ? ' — banned' : ''}
                    {m.overridden ? ' — custom lanes' : ''}
                  </span>
                  {m.banned ? (
                    <button type="button" disabled={!m.key} onClick={() => replace(`Allow ${words(m.turn)} turn`, withoutMovementEdits(changeset, m, 'ban'))}>
                      Allow
                    </button>
                  ) : (
                    <button type="button" disabled={!m.key} onClick={() => apply(() => banMovement(m))}>
                      Ban
                    </button>
                  )}
                  {m.overridden && (
                    <button type="button" onClick={() => replace(`Default lanes for ${words(m.turn)} turn`, withoutMovementEdits(changeset, m, 'all'))}>
                      Reset
                    </button>
                  )}
                </div>
                {!m.banned && (
                  <table className="lane-grid">
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="visually-hidden">From lane</span>
                        </th>
                        {m.toLink.lanes.map((t) => (
                          <th key={t.index} scope="col">
                            → {t.index}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {m.fromLink.lanes.map((f) => (
                        <tr key={f.index}>
                          <th scope="row">{f.index}</th>
                          {m.toLink.lanes.map((t) => (
                            <td key={t.index}>
                              <input
                                type="checkbox"
                                disabled={!m.key}
                                aria-label={`Lane ${f.index} to lane ${t.index}, ${words(m.turn)} ${armLabel(m.toLink, false)}`}
                                checked={connected(m, f.index, t.index)}
                                onChange={() => apply(() => toggleConnection(m, f.index, t.index))}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}
