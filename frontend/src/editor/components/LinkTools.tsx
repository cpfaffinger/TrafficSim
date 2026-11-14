import { useState } from 'react';
import type { PackageIndex } from '../../network/inspect';
import type { Link } from '../../network/types';
import { markingOf, MAX_LANE_WIDTH, MIN_LANE_WIDTH, nextMarking } from '../laneProfile';
import {
  addLane,
  defaultLayer,
  moveLaneToOpposite,
  removeLane,
  removeRoad,
  setBoundaryMarking,
  setBusLane,
  setCentreLine,
  setDestinationOnly,
  setHgvBan,
  setLaneWidth,
  setSpeedLimit,
  setStructure,
  setTurns,
  toggleOneway,
  type EditableStructure,
  type LinkEditContext,
} from '../linkEdits';
import type { EditResult } from '../ops';
import { wayDirection, type EditScope } from '../wayContext';
import { EditorSection, TurnToggles } from './common';

export interface LinkToolsProps {
  index: PackageIndex;
  link: Link;
  /** Highlighted lane (when a lane was picked). */
  laneIndex: number | null;
  changeset: LinkEditContext['changeset'];
  scope: EditScope;
  apply: (build: () => EditResult) => boolean;
}

const MARKING_TEXT = { dashed: '┆ dashed', solid: '│ solid', double_solid: '║ double solid', solid_dashed: '│┆ only right lane may cross', dashed_solid: '┆│ only left lane may cross' };

const kmh = (ms: number) => Math.round(ms * 3.6);

/** Lane, turn, marking, speed, access and structure tools for one link (#65, #66, #67, #69, #98). */
export function LinkTools({ index, link, laneIndex, changeset, scope, apply }: LinkToolsProps) {
  const ctx: LinkEditContext = { index, changeset, scope };
  const run = (build: (c: LinkEditContext) => EditResult) => apply(() => build(ctx));
  const direction = wayDirection(index, link);
  const twoWay = direction !== 'oneway';
  const [width, setWidth] = useState(String(link.lanes[0]?.width ?? 3.25));
  const [speed, setSpeed] = useState(String(kmh(link.speedLimit)));
  const [bothDirections, setBothDirections] = useState(false);
  const [structure, setStructureChoice] = useState<EditableStructure>(link.structure === 'tunnel' ? 'tunnel' : link.structure === 'bridge' ? 'bridge' : 'none');
  const [layer, setLayer] = useState(String(link.layer));
  const lanesLeftFirst = [...link.lanes].reverse();
  const trucksBanned = link.lanes.every((l) => !l.allowed.includes('truck'));
  const centreSolid = link.leftEdge === 'centre_solid' || link.leftEdge === 'double_solid';

  return (
    <>
      <EditorSection title={`Lanes (${direction === 'oneway' ? 'one-way' : `${direction} direction`})`}>
        <button type="button" onClick={() => run((c) => addLane(c, link, 'left'))}>
          + Lane on the left
        </button>
        <ol className="lane-rows" aria-label="Lanes, leftmost first">
          {lanesLeftFirst.map((lane) => {
            const i = lane.index;
            const name = `lane ${i}${i === 0 ? ' (rightmost)' : i === link.lanes.length - 1 ? ' (leftmost)' : ''}`;
            const boundary = i > 0 ? link.boundaries[i - 1] : undefined;
            const busOnly = lane.allowed.length === 1 && lane.allowed[0] === 'bus';
            return (
              <li key={lane.id} className={laneIndex === i ? 'selected' : undefined}>
                <div className="lane-row">
                  <span className="lane-name">{name.replace(/^lane/, 'Lane')}</span>
                  <TurnToggles turns={lane.turns} laneLabel={name} onChange={(turns) => run((c) => setTurns(c, link, i, turns))} />
                  <label className="inline">
                    <input type="checkbox" checked={busOnly} onChange={(e) => run((c) => setBusLane(c, link, i, e.target.checked))} /> Bus
                  </label>
                  <button type="button" className="glyph" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={() => run((c) => removeLane(c, link, i))}>
                    ×
                  </button>
                </div>
                {boundary && (
                  <button
                    type="button"
                    className="boundary"
                    title="Lane marking between these lanes — click to change (dashed → solid → one-sided)"
                    aria-label={`Marking between lane ${i} and lane ${i - 1}: ${boundary.marking.replace(/_/g, ' ')}. Change`}
                    onClick={() => run((c) => setBoundaryMarking(c, link, i - 1, nextMarking(markingOf(boundary))))}
                  >
                    {MARKING_TEXT[boundary.marking]}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={() => run((c) => addLane(c, link, 'right'))}>
          + Lane on the right
        </button>
        <div className="field-row">
          <label htmlFor="lane-width">Lane width (m)</label>
          <input
            id="lane-width"
            type="number"
            min={MIN_LANE_WIDTH}
            max={MAX_LANE_WIDTH}
            step={0.05}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
          />
          <button type="button" onClick={() => run((c) => setLaneWidth(c, link, laneIndex, Number(width)))}>
            Set {laneIndex === null ? 'all' : `lane ${laneIndex}`}
          </button>
        </div>
        <div className="buttons">
          <button type="button" onClick={() => run((c) => toggleOneway(c, link))}>
            {twoWay ? 'Make one-way (this direction)' : 'Make two-way'}
          </button>
          {twoWay && (
            <button type="button" onClick={() => run((c) => moveLaneToOpposite(c, link))}>
              Move a lane to the other direction
            </button>
          )}
        </div>
        {twoWay && (
          <label className="inline">
            <input type="checkbox" checked={centreSolid} onChange={(e) => run((c) => setCentreLine(c, link, e.target.checked))} /> Solid centre line (no
            overtaking)
          </label>
        )}
      </EditorSection>

      <EditorSection title="Speed and access">
        <div className="field-row">
          <label htmlFor="speed-limit">Speed limit (km/h)</label>
          <input id="speed-limit" type="number" min={5} max={200} step={5} value={speed} onChange={(e) => setSpeed(e.target.value)} />
          <button type="button" onClick={() => run((c) => setSpeedLimit(c, link, Number(speed), bothDirections))}>
            Set
          </button>
          <button type="button" onClick={() => run((c) => setSpeedLimit(c, link, null, bothDirections))} title="Use the default for the road class">
            Default
          </button>
        </div>
        {twoWay && (
          <label className="inline">
            <input type="checkbox" checked={bothDirections} onChange={(e) => setBothDirections(e.target.checked)} /> Both directions
          </label>
        )}
        <label className="inline">
          <input type="checkbox" checked={trucksBanned} onChange={(e) => run((c) => setHgvBan(c, link, e.target.checked))} /> No trucks (hgv=no)
        </label>
        <label className="inline">
          <input type="checkbox" checked={!link.throughTraffic} onChange={(e) => run((c) => setDestinationOnly(c, link, e.target.checked))} /> Destination
          traffic only
        </label>
      </EditorSection>

      <EditorSection title="Structure" open={false}>
        <div className="field-row">
          <label htmlFor="structure">Type</label>
          <select
            id="structure"
            value={structure}
            onChange={(e) => {
              const s = e.target.value as EditableStructure;
              setStructureChoice(s);
              setLayer(String(defaultLayer(s)));
            }}
          >
            <option value="none">At grade</option>
            <option value="bridge">Bridge</option>
            <option value="tunnel">Tunnel</option>
          </select>
          <label htmlFor="layer">Layer</label>
          <input id="layer" type="number" min={-5} max={5} step={1} value={layer} onChange={(e) => setLayer(e.target.value)} />
          <button type="button" onClick={() => run((c) => setStructure(c, link, structure, Number(layer)))}>
            Apply
          </button>
        </div>
        <p className="muted small">Roads only form a junction where they share a node; bridges and tunnels cross without one.</p>
      </EditorSection>

      <EditorSection title="Remove" open={false}>
        <button type="button" className="danger" onClick={() => run((c) => removeRoad(c, link))}>
          Remove road ({scope === 'part' ? 'this part' : 'whole road'})
        </button>
      </EditorSection>
    </>
  );
}
