/** Side panel of the demo town (#145). */
export function DemoIntro({ error }: { error: string | null }) {
  return (
    <section aria-label="Demo town">
      <h2>Demo town</h2>
      <p className="muted">
        A small synthetic town (not a real place): a main road with a signalised junction, a pedestrian crossing with
        lights and a zebra crossing, side streets that give way, and residential streets with priority to the right.
      </p>
      <p className="muted small">Start the simulation below; click vehicles, lanes, junctions and signals to inspect them.</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
