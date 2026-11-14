import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { diffColor, metricColor, metricValues, smoothAlongLanes, writeCellColors, type HeatmapMetric } from '../metrics/heatmapMetrics';
import { cellDelta } from '../runs/compare';
import type { CellDiff } from '../runs/ComparePanel';
import { CellHistory, decodeLaneCells } from '../metrics/laneCells';
import type { NetworkPackage } from '../network/types';
import type { NetworkScene } from '../scene/NetworkScene';

export const REPLAY_INTERVAL_MS = 350;

/** Glue between streamed lane-cell buckets, the heatmap layer and the timeline (#59, #60). */
export function useHeatmap(sceneRef: RefObject<NetworkScene | null>, pkg: NetworkPackage | null) {
  const history = useRef(new CellHistory());
  const [range, setRange] = useState<[number, number] | null>(null);
  const [bucket, setBucket] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [metric, setMetric] = useState<HeatmapMetric>('speedRatio');
  const [smooth, setSmooth] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [version, setVersion] = useState(0);
  /** A/B comparison (#74): overrides the live / timeline view while set. */
  const [diff, setDiff] = useState<CellDiff | null>(null);
  const bucketRef = useRef<number | null>(null);
  bucketRef.current = bucket;

  useEffect(() => {
    history.current.clear();
    setRange(null);
    setBucket(null);
    setReplaying(false);
  }, [pkg]);

  const onCells = useCallback((blob: ArrayBuffer) => {
    const decoded = decodeLaneCells(blob);
    // A restarted simulation streams from bucket 0 again.
    if (decoded.buckets[0]?.index === 0 && history.current.size > 0) history.current.clear();
    history.current.add(decoded);
    setRange(history.current.range());
    setVersion((v) => v + 1);
  }, []);

  // Render the A/B diff or the shown bucket.
  useEffect(() => {
    const scene = sceneRef.current;
    if (diff) {
      scene?.setHeatmapVisible(enabled);
      if (!scene || !enabled) return;
      const colors = scene.prepareHeatmap(diff.b.lanes, diff.b.cellCount, diff.b.cellLength);
      if (!colors) return;
      let values = cellDelta(diff.a, diff.b, metric);
      if (smooth) values = smoothAlongLanes(values, diff.b.lanes);
      writeCellColors(colors, values, (v) => diffColor(metric, v));
      scene.commitHeatmap();
      return;
    }
    const h = history.current;
    scene?.setHeatmapVisible(enabled && range !== null);
    if (!scene || !enabled || !range || !h.layout) return;
    const shown = h.get(bucket ?? range[1]) ?? h.get(range[1]);
    if (!shown) return;
    const colors = scene.prepareHeatmap(h.layout.lanes, h.layout.cellCount, h.layout.cellLength);
    if (!colors) return;
    let values = metricValues(shown, metric);
    if (smooth) values = smoothAlongLanes(values, h.layout.lanes);
    writeCellColors(colors, values, (v) => metricColor(metric, v));
    scene.commitHeatmap();
  }, [enabled, metric, smooth, bucket, range, version, sceneRef, diff]);

  // Replay: step through the retained buckets.
  useEffect(() => {
    if (!replaying || !range) return;
    const id = setInterval(() => {
      const current = bucketRef.current ?? range[0];
      if (current >= range[1]) {
        setReplaying(false);
        return;
      }
      setBucket(current + 1);
    }, REPLAY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [replaying, range]);

  const replay = useCallback(
    (on: boolean) => {
      if (on && range && (bucketRef.current === null || bucketRef.current >= range[1])) setBucket(range[0]);
      setReplaying(on);
    },
    [range],
  );

  return {
    history: history.current,
    range,
    bucket,
    live: bucket === null,
    enabled,
    metric,
    smooth,
    replaying,
    onCells,
    diff,
    setDiff,
    setBucket: (b: number) => {
      setReplaying(false);
      setBucket(b);
    },
    goLive: () => {
      setReplaying(false);
      setBucket(null);
    },
    setEnabled,
    setMetric,
    setSmooth,
    replay,
    timeOfDay: (b: number) => history.current.timeOfDay(b),
  };
}
