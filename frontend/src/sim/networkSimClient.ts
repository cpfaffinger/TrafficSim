import type { DebugKind, FromNetworkWorker, NetworkSimSettings, ToNetworkWorker } from './networkProtocol';

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
  private readonly debugRequests = new Map<number, { resolve: (json: string) => void; reject: (error: Error) => void }>();
  private nextRequest = 1;

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

  /** Frames carry this vehicle's state from now on (null stops it, #125). */
  watchVehicle(vehicle: number | null): void {
    this.worker.postMessage({ type: 'watch', vehicle });
  }

  /** Debug snapshot (#129) of a vehicle, link, lane or junction as JSON text. */
  requestDebug(kind: DebugKind, id: string, lane = -1): Promise<string> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.debugRequests.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'debug', requestId, kind, id, lane });
    });
  }

  requestResults(): void {
    this.worker.postMessage({ type: 'results' });
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
  }

  private emit(message: FromNetworkWorker): void {
    if (message.type === 'debug') {
      const pending = this.debugRequests.get(message.requestId);
      this.debugRequests.delete(message.requestId);
      if (message.json !== null) pending?.resolve(message.json);
      else pending?.reject(new Error(message.error ?? 'No debug data'));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
}
