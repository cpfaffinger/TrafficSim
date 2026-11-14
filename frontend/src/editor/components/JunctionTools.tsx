import { useState } from 'react';
import type { PackageIndex } from '../../network/inspect';
import { CONTROL_CHOICES, CONTROL_LABELS, controlChoiceOf, convertToRoundabout, MAX_ROUNDABOUT_RADIUS, MIN_ROUNDABOUT_RADIUS, setNodeControl, type ControlChoice } from '../nodeEdits';
import type { Changeset, EditResult } from '../ops';
import { EditorSection } from './common';
import { MovementEditor } from './MovementEditor';
import { SignalPlanEditor } from './SignalPlanEditor';

export interface JunctionToolsProps {
  index: PackageIndex;
  nodeId: string;
  changeset: Changeset;
  apply: (build: () => EditResult) => boolean;
  replace: (label: string, changeset: Changeset) => void;
}

/** Junction control, signal plan, roundabout conversion and lane connections (#66, #68, #69, #98). */
export function JunctionTools({ index, nodeId, changeset, apply, replace }: JunctionToolsProps) {
  const node = index.nodes.get(nodeId)!;
  const [control, setControl] = useState<ControlChoice>(controlChoiceOf(node.control));
  const [radius, setRadius] = useState('15');
  const editable = node.osmId !== null;

  return (
    <>
      {!editable && <p className="muted small">This is a network boundary point, not an OpenStreetMap node; it cannot be edited.</p>}
      <EditorSection title="Control">
        <div className="field-row">
          <label htmlFor="control">Junction control</label>
          <select id="control" value={control} disabled={!editable} onChange={(e) => setControl(e.target.value as ControlChoice)}>
            {CONTROL_CHOICES.map((c) => (
              <option key={c} value={c}>
                {CONTROL_LABELS[c]}
              </option>
            ))}
          </select>
          <button type="button" disabled={!editable} onClick={() => apply(() => setNodeControl(node, control))}>
            Apply
          </button>
        </div>
        <p className="muted small">Currently: {node.control.replace(/_/g, ' ')}. Signs apply to the minor approaches.</p>
      </EditorSection>
      {node.control === 'signal' && (
        <EditorSection title="Signal plan">
          {/* Re-read the draft whenever the compiled plan changes (e.g. after applying it). */}
          <SignalPlanEditor key={`${nodeId}:${JSON.stringify(index.signals.get(nodeId) ?? null)}`} index={index} nodeId={nodeId} apply={apply} />
        </EditorSection>
      )}
      <EditorSection title="Lane connections and turns">
        <MovementEditor index={index} nodeId={nodeId} changeset={changeset} apply={apply} replace={replace} />
      </EditorSection>
      <EditorSection title="Roundabout" open={false}>
        <div className="field-row">
          <label htmlFor="radius">Radius (m)</label>
          <input id="radius" type="number" min={MIN_ROUNDABOUT_RADIUS} max={MAX_ROUNDABOUT_RADIUS} value={radius} onChange={(e) => setRadius(e.target.value)} />
          <button type="button" disabled={!editable} onClick={() => apply(() => convertToRoundabout(node, Number(radius)))}>
            Convert to roundabout
          </button>
        </div>
      </EditorSection>
    </>
  );
}
