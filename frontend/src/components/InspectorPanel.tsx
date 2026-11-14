import type { InspectorModel } from '../network/inspect';

export interface InspectorPanelProps {
  model: InspectorModel | null;
  onClose: () => void;
}

/** Details of the picked lane, link, movement or junction (#37). */
export function InspectorPanel({ model, onClose }: InspectorPanelProps) {
  if (!model) {
    return (
      <section className="inspector inspector-empty" aria-label="Inspector">
        <p className="muted">Click a lane, junction or bridge to inspect it. Click the same spot again to select what lies below.</p>
      </section>
    );
  }
  const hasAssumed = model.sections.some((s) => s.fields.some((f) => f.assumed));
  return (
    <section className="inspector" aria-label="Inspector">
      <header className="inspector-header">
        <h2>{model.title}</h2>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </header>
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
    </section>
  );
}
