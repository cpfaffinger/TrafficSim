import type { InspectorModel } from '../network/inspect';

export interface InspectorPanelProps {
  model: InspectorModel | null;
  onClose: () => void;
  /** Downloads a debug snapshot of the selection as JSON (#129); absent without a running simulation. */
  onDebug?: () => void;
  /** Buttons for the selection, e.g. focus and follow a vehicle (#130). */
  actions?: { label: string; onClick: () => void; pressed?: boolean }[];
}

/** Details of the picked lane, link, movement or junction (#37). */
export function InspectorPanel({ model, onClose, onDebug, actions }: InspectorPanelProps) {
  // Nothing selected: the scene stays clear (#128); the hint is in the View section.
  if (!model) return null;
  const hasAssumed = model.sections.some((s) => s.fields.some((f) => f.assumed));
  return (
    <section className="inspector" aria-label="Inspector">
      <header className="inspector-header">
        <h2>{model.title}</h2>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </header>
      {actions && actions.length > 0 && (
        <div className="inspector-actions">
          {actions.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} aria-pressed={a.pressed}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {model.sections.map((section) => (
        <div key={section.title} className="inspector-section">
          <h3>{section.title}</h3>
          <dl className="stats">
            {section.fields.map((f) => (
              <div key={f.label} className="inspector-row">
                <dt>{f.label}</dt>
                <dd>
                  {f.value}
                  {f.assumed && (
                    <abbr className="assumed" title="Assumed: filled from defaults, not from OpenStreetMap">
                      *
                    </abbr>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {hasAssumed && <p className="muted small">* assumed value (default, not tagged in OpenStreetMap)</p>}
      {onDebug && (
        <button type="button" className="inspector-debug" onClick={onDebug}>
          Download debug JSON
        </button>
      )}
    </section>
  );
}
