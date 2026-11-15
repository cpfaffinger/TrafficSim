import { useState } from 'react';

const STEP = (15 * Math.PI) / 180;

export interface CameraPadTarget {
  orbitBy(dYaw: number, dPitch: number): void;
  setViewMode(mode: '2d' | '3d', north?: boolean): void;
  northUp(): void;
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
        ⤓
      </button>
      <button type="button" onClick={() => tilt(false)} aria-label="Tilt less (towards top view)" title="Tilt less">
        ⤒
      </button>
      <button type="button" onClick={() => scene()?.orbitBy(-STEP, 0)} aria-label="Rotate left" title="Rotate left">
        ⟲
      </button>
      <button type="button" onClick={() => scene()?.orbitBy(STEP, 0)} aria-label="Rotate right" title="Rotate right">
        ⟳
      </button>
      <button type="button" onClick={() => scene()?.northUp()} aria-label="North up" title="North up">
        N
      </button>
    </div>
  );
}
