export interface AttributionBarProps {
  attributions: string[];
  onAbout: () => void;
}

/** Always-visible attribution line (#38). */
export function AttributionBar({ attributions, onAbout }: AttributionBarProps) {
  return (
    <footer className="attribution-bar" aria-label="Attribution">
      <span className="attribution-texts">
        {attributions.map((a, i) => (
          <span key={a}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            {a}
          </span>
        ))}
      </span>
      <button type="button" className="link-button" onClick={onAbout}>
        About &amp; legal
      </button>
    </footer>
  );
}
