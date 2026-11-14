export interface UpdateBannerProps {
  onReload: () => void;
}

/** Shown when a newer deployment is live than the code running in this tab. */
export function UpdateBanner({ onReload }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <span>A new version of TrafficSim is available.</span>
      <button type="button" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
