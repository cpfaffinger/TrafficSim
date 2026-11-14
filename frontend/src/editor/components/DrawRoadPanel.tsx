import { NEW_ROAD_CLASSES, type RoadSpec } from '../drawRoad';
import { defaultLayer, type EditableStructure } from '../linkEdits';
import type { RoadDraft } from '../useRoadDraft';

export interface DrawRoadPanelProps {
  draft: RoadDraft;
  onFinish: () => void;
}

const words = (s: string) => s.replace(/_/g, ' ');

/** Settings and actions of the "draw road" tool (#69). */
export function DrawRoadPanel({ draft, onFinish }: DrawRoadPanelProps) {
  const { spec, points } = draft;
  const set = (change: Partial<RoadSpec>) => draft.setSpec({ ...spec, ...change });
  const attached = points.filter((p) => p.kind !== 'free').length;
  return (
    <section className="draw-panel" aria-label="Draw road">
      <header className="inspector-header">
        <h2>Draw a road</h2>
      </header>
      <p className="small">
        Click points on the ground. Clicks near a junction snap to it; clicks on a road connect to it (near its ends where the exact OSM node is
        known). Enter finishes, Backspace removes the last point, Esc cancels.
      </p>
      <p className="small" role="status">
        {points.length} point{points.length === 1 ? '' : 's'}
        {attached ? `, ${attached} connected to the network` : ''}
      </p>
      <div className="form-grid">
        <label htmlFor="road-class">Class</label>
        <select id="road-class" value={spec.highway} onChange={(e) => set({ highway: e.target.value as RoadSpec['highway'] })}>
          {NEW_ROAD_CLASSES.map((c) => (
            <option key={c} value={c}>
              {words(c)}
            </option>
          ))}
        </select>
        <label htmlFor="road-lanes">Lanes per direction</label>
        <input id="road-lanes" type="number" min={1} max={4} value={spec.lanes} onChange={(e) => set({ lanes: Number(e.target.value) })} />
        <label htmlFor="road-oneway">One-way</label>
        <input id="road-oneway" type="checkbox" checked={spec.oneway} onChange={(e) => set({ oneway: e.target.checked })} />
        <label htmlFor="road-speed">Speed (km/h)</label>
        <input
          id="road-speed"
          type="number"
          min={5}
          max={200}
          placeholder="default"
          value={spec.maxspeed ?? ''}
          onChange={(e) => set({ maxspeed: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <label htmlFor="road-structure">Structure</label>
        <select
          id="road-structure"
          value={spec.structure}
          onChange={(e) => {
            const structure = e.target.value as EditableStructure;
            set({ structure, layer: defaultLayer(structure) });
          }}
        >
          <option value="none">At grade</option>
          <option value="bridge">Bridge</option>
          <option value="tunnel">Tunnel</option>
        </select>
        <label htmlFor="road-layer">Layer</label>
        <input id="road-layer" type="number" min={-5} max={5} value={spec.layer} onChange={(e) => set({ layer: Number(e.target.value) })} />
        <label htmlFor="road-name">Name</label>
        <input id="road-name" type="text" value={spec.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="buttons">
        <button type="button" className="primary" disabled={points.length < 2} onClick={onFinish}>
          Finish road
        </button>
        <button type="button" disabled={points.length === 0} onClick={draft.back}>
          Remove last point
        </button>
        <button type="button" disabled={points.length === 0} onClick={draft.cancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
