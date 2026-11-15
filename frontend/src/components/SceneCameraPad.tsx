import { useState, type ReactNode } from 'react';

const STEP = (15 * Math.PI) / 180;

export interface CameraPadTarget {
  orbitBy(dYaw: number, dPitch: number): void;
  setViewMode(mode: '2d' | '3d', north?: boolean): void;
  northUp(): void;
}

/** 18 px stroke icon, centred in its button (#144: text arrows sat off-centre on phones). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Visible camera controls on the 3D view (#144): 2D/3D, tilt, rotate, north up. */
export function SceneCameraPad({ scene }: { scene: () => CameraPadTarget | null }) {
  const [mode, setMode] = useState<'2d' | '3d'>('3d');
  const toggle = () => {
    const next = mode === '3d' ? '2d' : '3d';
    setMode(next);
    scene()?.setViewMode(next, next === '2d');
  };
  const tilt = (more3d: boolean) => {
    setMode('3d');
    scene()?.orbitBy(0, more3d ? -STEP : STEP);
  };
  return (
    <div className="camera-pad" role="toolbar" aria-label="Camera">
      <button type="button" className="camera-pad-mode" onClick={toggle} aria-label={mode === '3d' ? 'Switch to 2D top view' : 'Switch to tilted 3D view'}>
        {mode === '3d' ? '2D' : '3D'}
      </button>
      <button type="button" onClick={() => tilt(true)} aria-label="Tilt more (3D)" title="Tilt more">
        <Icon>
          <path d="M4 18h16M7 13l5 5 5-5M12 4v14" />
        </Icon>
      </button>
      <button type="button" onClick={() => tilt(false)} aria-label="Tilt less (towards top view)" title="Tilt less">
        <Icon>
          <path d="M4 6h16M7 11l5-5 5 5M12 20V6" />
        </Icon>
      </button>
      <button type="button" onClick={() => scene()?.orbitBy(-STEP, 0)} aria-label="Rotate left" title="Rotate left">
        <Icon>
          <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4.5h4.5" />
        </Icon>
      </button>
      <button type="button" onClick={() => scene()?.orbitBy(STEP, 0)} aria-label="Rotate right" title="Rotate right">
        <Icon>
          <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5" />
        </Icon>
      </button>
      <button type="button" onClick={() => scene()?.northUp()} aria-label="North up" title="North up">
        N
      </button>
    </div>
  );
}
