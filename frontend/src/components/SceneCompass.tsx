import { useEffect, useRef, useState } from 'react';

export interface CompassTarget {
  cameraYaw(): number;
  northUp(): void;
}

/** Compass on the 3D view (#156): the needle points north; a click turns the view north up. */
export function SceneCompass({ scene }: { scene: () => CompassTarget | null }) {
  const [yaw, setYaw] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const y = scene()?.cameraYaw() ?? 0;
      if (Math.abs(y - last.current) > 0.005) {
        last.current = y;
        setYaw(y);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [scene]);
  const degrees = (yaw * 180) / Math.PI;
  return (
    <button type="button" className="scene-compass" onClick={() => scene()?.northUp()} aria-label="North up" title="North up">
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <circle cx="20" cy="20" r="18" className="compass-ring" />
        <g transform={`rotate(${degrees.toFixed(1)} 20 20)`}>
          <text x="20" y="11" textAnchor="middle" className="compass-n">
            N
          </text>
          <path d="M20 12 L24 21 L16 21 Z" className="compass-north" />
          <path d="M20 31 L24 21 L16 21 Z" className="compass-south" />
        </g>
      </svg>
    </button>
  );
}
