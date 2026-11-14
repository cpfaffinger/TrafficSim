import { useEffect, useMemo, useState } from 'react';
import type { NetworkPackage } from '../network/types';
import type { Builtins } from './builtins';
import { CurvesTab } from './components/CurvesTab';
import { EntriesTab } from './components/EntriesTab';
import { MixEditor } from './components/MixEditor';
import { OdTab } from './components/OdTab';
import { OverviewTab } from './components/OverviewTab';
import { curveNames as allCurveNames } from './curves';
import { setMix } from './edits';
import { parseDemand, serializeDemand, type DemandModel } from './model';
import { boundaryEntries } from './network';
import { DEFAULT_OD_VIEW, type OdView } from './odTable';
import { demandTotals } from './totals';
import { mixNames as allMixNames, validateDemand, type DemandSection } from './validate';
import { zonesAt } from './zones';
import { TransitTab } from '../transit/TransitTab';

/** What the map should emphasise. */
export interface DemandHighlight {
  /** Zone filter of the OD table. */
  zone: string | null;
  /** Origin and destination zone of the selected OD entry. */
  from: string | null;
  to: string | null;
  /** Selected boundary entry nodes. */
  nodes: string[];
}

/** A pick on the map: a link (with its end nodes) or a node. */
export interface DemandPick {
  linkId?: string;
  nodeIds?: string[];
}

export interface DemandEditorProps {
  scenario: { id: string; name: string; demand: unknown; durationSeconds: number };
  pkg: NetworkPackage | null;
  builtins: Builtins;
  readOnly?: boolean;
  picked?: DemandPick | null;
  onSave?: (demand: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  onHighlight?: (highlight: DemandHighlight) => void;
  confirm?: (message: string) => boolean;
}

const TABS: { id: DemandSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'od', label: 'OD matrix' },
  { id: 'entries', label: 'Entries' },
  { id: 'curves', label: 'Curves' },
  { id: 'mixes', label: 'Mixes' },
  { id: 'transit', label: 'Transit' },
];

const json = (m: DemandModel) => JSON.stringify(serializeDemand(m));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');

/** Demand editor of the open scenario (#54): start time, OD matrix, boundary entries, curves and mixes. */
export function DemandEditor({ scenario, pkg, builtins, readOnly = false, picked, onSave, onClose, onHighlight, confirm = (m) => window.confirm(m) }: DemandEditorProps) {
  const [model, setModel] = useState<DemandModel>(() => parseDemand(scenario.demand));
  const [saved, setSaved] = useState(() => json(parseDemand(scenario.demand)));
  const [tab, setTab] = useState<DemandSection>('overview');
  const [view, setView] = useState<OdView>(DEFAULT_OD_VIEW);
  const [selectedOd, setSelectedOd] = useState<number | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = json(model) !== saved;

  // The scenario's demand changed elsewhere (settings form, another save): adopt it unless edited here.
  const incoming = useMemo(() => json(parseDemand(scenario.demand)), [scenario.demand]);
  const [seen, setSeen] = useState(incoming);
  if (incoming !== seen) {
    setSeen(incoming);
    setSaved(incoming);
    if (!dirty) setModel(parseDemand(scenario.demand));
  }
  const issues = useMemo(() => validateDemand(model, builtins, pkg), [model, builtins, pkg]);
  const invalid = useMemo(() => new Set(issues.map((i) => i.path)), [issues]);
  const curveNames = useMemo(() => allCurveNames(model.curves), [model.curves]);
  const names = useMemo(() => allMixNames(model, builtins), [model, builtins]);
  const entries = useMemo(() => (pkg ? boundaryEntries(pkg, model, builtins) : []), [pkg, model, builtins]);
  const totals = useMemo(() => demandTotals(model, scenario.durationSeconds, builtins, pkg), [model, scenario.durationSeconds, builtins, pkg]);
  const timeWindow = { start: model.startTimeOfDay, duration: scenario.durationSeconds };
  const transitLines = pkg?.transitLines ?? [];

  const change = (next: DemandModel) => {
    setModel(next);
    setStatus(null);
  };

  const od = selectedOd !== null ? model.od[selectedOd] : undefined;
  const highlightKey = JSON.stringify([view.zone, od?.from, od?.to, tab === 'entries' ? selectedEntry : null]);
  useEffect(() => {
    const [zone, from, to, node] = JSON.parse(highlightKey) as [string | null, string | undefined, string | undefined, string | null];
    onHighlight?.({ zone, from: from ?? null, to: to ?? null, nodes: node ? [node] : [] });
  }, [highlightKey, onHighlight]);

  // A pick on the map selects the entry node (Entries tab) or filters the OD table by the picked zone.
  const pickKey = picked ? JSON.stringify(picked) : null;
  useEffect(() => {
    if (!pickKey) return;
    const pick = JSON.parse(pickKey) as DemandPick;
    if (tab === 'entries') {
      const node = pick.nodeIds?.find((n) => entries.some((e) => e.node === n));
      if (node) setSelectedEntry(node);
      return;
    }
    const zones = zonesAt(model.zones, pick);
    if (zones.length === 0) return;
    setView((v) => {
      const at = v.zone ? zones.indexOf(v.zone) : -1;
      return { ...v, zone: zones[(at + 1) % zones.length]! };
    });
    setSelectedOd(null);
    setTab('od');
    // Only react to new picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);

  const close = () => {
    if (dirty && !readOnly && !confirm('Discard unsaved demand changes?')) return;
    onClose();
  };

  const save = async () => {
    if (!onSave || issues.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const demand = serializeDemand(model);
      await onSave(demand);
      setSaved(JSON.stringify(demand));
      setStatus('Demand saved.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const count = (section: DemandSection) => issues.filter((i) => i.section === section).length;

  return (
    <section className="demand-editor" aria-label="Demand editor">
      <header className="demand-header">
        <h2>
          Demand · {scenario.name}
          {dirty && !readOnly && <span className="muted"> (unsaved)</span>}
        </h2>
        {readOnly && <span className="badge">Read-only</span>}
        <button type="button" className="icon" aria-label="Close demand editor" onClick={close}>
          ×
        </button>
      </header>
      <div className="demand-tabs" role="tablist" aria-label="Demand sections">
        {TABS.filter((t) => t.id !== 'transit' || transitLines.length > 0).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : undefined} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'od' ? ` (${model.od.length})` : ''}
            {count(t.id) > 0 && <span className="issue-count" aria-label={`${count(t.id)} problems`}>{count(t.id)}</span>}
          </button>
        ))}
      </div>
      <div className="demand-body" role="tabpanel">
        {tab === 'overview' && <OverviewTab model={model} durationSeconds={scenario.durationSeconds} totals={totals} readOnly={readOnly} onChange={change} crossings={pkg?.crossings?.length ?? 0} />}
        {tab === 'od' && (
          <OdTab
            model={model}
            onChange={change}
            view={view}
            onView={setView}
            selected={selectedOd}
            onSelect={setSelectedOd}
            curveNames={curveNames}
            mixNames={names}
            invalid={invalid}
            window={timeWindow}
            readOnly={readOnly}
          />
        )}
        {tab === 'entries' && (
          <EntriesTab
            model={model}
            onChange={change}
            entries={entries}
            builtins={builtins}
            curveNames={curveNames}
            selected={selectedEntry}
            onSelect={setSelectedEntry}
            invalid={invalid}
            readOnly={readOnly}
          />
        )}
        {tab === 'transit' && (
          <TransitTab lines={transitLines} value={model.rest.transit} readOnly={readOnly} onChange={(transit) => change({ ...model, rest: { ...model.rest, transit } })} />
        )}
        {tab === 'curves' && <CurvesTab model={model} onChange={change} curveNames={curveNames} window={timeWindow} invalid={invalid} readOnly={readOnly} />}
        {tab === 'mixes' && (
          <div className="demand-tab">
            <MixEditor
              title="Vehicle mix"
              mix={model.vehicleMix}
              names={names.vehicle}
              fallback="cars only"
              seed={{ car: 0.85, van: 0.07, truck: 0.03, articulatedTruck: 0.02, motorcycle: 0.03 }}
              disabled={readOnly}
              onChange={(mix) => change(setMix(model, 'vehicleMix', mix))}
            />
            <MixEditor
              title="Driver mix"
              mix={model.driverMix}
              names={names.driver}
              fallback="legacy average drivers"
              seed={{ average: 0.5, attentive: 0.2, aggressive: 0.1, distracted: 0.1, commuter: 0.1 }}
              disabled={readOnly}
              onChange={(mix) => change(setMix(model, 'driverMix', mix))}
            />
            <p className="muted small">OD entries can override both mixes (OD matrix → entry details).</p>
          </div>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="demand-issues error small" aria-label="Problems">
          {issues.slice(0, 8).map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
          {issues.length > 8 && <li>… and {issues.length - 8} more</li>}
        </ul>
      )}
      {!readOnly && (
        <footer className="buttons demand-footer">
          <button type="button" className="primary" disabled={!dirty || saving || issues.length > 0 || !onSave} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save demand'}
          </button>
          <button type="button" disabled={!dirty || saving} onClick={() => change(parseDemand(JSON.parse(saved)))}>
            Revert
          </button>
          {status && (
            <span className="small" role="status">
              {status}
            </span>
          )}
          {error && (
            <span className="error small" role="alert">
              {error}
            </span>
          )}
        </footer>
      )}
    </section>
  );
}
