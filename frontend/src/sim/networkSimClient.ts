import type { FromNetworkWorker, NetworkSimSettings, ToNetworkWorker } from './networkProtocol';

/** Minimal worker surface so the client can be tested with a fake. */
export interface NetworkWorkerLike {
  postMessage(message: ToNetworkWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromNetworkWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type NetworkSimListener = (message: FromNetworkWorker) => void;

/** UI-side facade over the network simulation worker (#47). */
export class NetworkSimClient {
  private readonly listeners = new Set<NetworkSimListener>();

  constructor(private readonly worker: NetworkWorkerLike) {
    worker.onmessage = (event) => this.emit(event.data);
    worker.onerror = (event) => this.emit({ type: 'error', message: event.message || 'Simulation worker failed' });
  }

  static create(): NetworkSimClient {
    const worker = new Worker(new URL('./network.worker.ts', import.meta.url), { type: 'module', name: 'trafficsim-network-sim' });
    return new NetworkSimClient(worker as unknown as NetworkWorkerLike);
  }

  subscribe(listener: NetworkSimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  init(settings: NetworkSimSettings): void {
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

  setDemand(node: string, vehiclesPerHour: number): void {
    this.worker.postMessage({ type: 'demand', node, vehiclesPerHour });
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
  }

  private emit(message: FromNetworkWorker): void {
    for (const listener of this.listeners) listener(message);
  }
}
