export interface SceneCreditProps {
  onSources: () => void;
}

/**
 * The one credit line on the map (#128): OpenStreetMap's attribution guideline asks for a visible
 * "© OpenStreetMap" wherever its data is shown; everything else is on the sources page.
 */
export function SceneCredit({ onSources }: SceneCreditProps) {
  return (
    <p className="scene-credit">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        © OpenStreetMap
      </a>
      <span aria-hidden="true"> · </span>
      <button type="button" className="link-button" onClick={onSources}>
        Sources
      </button>
    </p>
  );
}
