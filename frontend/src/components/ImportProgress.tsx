import { phaseProgress, type ImportPhase } from '../lib/importJob';

export interface ImportProgressProps {
  phase: ImportPhase;
  error: string | null;
}

/** Import progress (#34): phase label and an approximate progress bar. */
export function ImportProgress({ phase, error }: ImportProgressProps) {
  const { label, fraction } = phaseProgress(phase);
  return (
    <section aria-label="Import progress">
      <h2>Import</h2>
      <progress max={100} value={Math.round(fraction * 100)} aria-label={label} />
      <p aria-live="polite" className={phase === 'failed' ? 'error' : undefined}>
        {phase === 'failed' && error ? `Import failed: ${error}` : label}
      </p>
    </section>
  );
}
