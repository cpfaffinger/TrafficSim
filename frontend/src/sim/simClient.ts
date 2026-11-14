import type { FromWorker, RingSettings, ToWorker } from './protocol';

/** Minimal worker surface so the client can be tested with a fake. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type SimListener = (message: FromWorker) => void;

/** UI-side facade over the simulation worker. */
export class SimClient {
  private readonly listeners = new Set<SimListener>();

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => this.emit(event.data);
    worker.onerror = (event) => this.emit({ type: 'error', message: event.message || 'Simulation worker failed' });
  }

  static create(): SimClient {
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module', name: 'trafficsim-sim' });
    return new SimClient(worker as unknown as WorkerLike);
  }

  subscribe(listener: SimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  init(settings: RingSettings): void {
    this.worker.postMessage({ type: 'init', settings });
  }

  play(): void {
    this.worker.postMessage({ type: 'play' });
  }

  pause(): void {
    this.worker.postMessage({ type: 'pause' });
  }

  setSpeed(factor: number): void {
    this.worker.postMessage({ type: 'speed', factor });
  }

  perturb(vehicle = 0, speedFactor = 0.2): void {
    this.worker.postMessage({ type: 'perturb', vehicle, speedFactor });
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.terminate();
  }

  private emit(message: FromWorker): void {
    for (const listener of this.listeners) listener(message);
  }
}
