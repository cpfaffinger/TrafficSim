import { describe, expect, it, vi } from 'vitest';
import type { FromNetworkWorker, ToNetworkWorker } from './networkProtocol';
import { NetworkSimClient, type NetworkWorkerLike } from './networkSimClient';

class FakeWorker implements NetworkWorkerLike {
  sent: ToNetworkWorker[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromNetworkWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: ToNetworkWorker): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('NetworkSimClient', () => {
  it('sends commands and forwards worker messages', () => {
    const worker = new FakeWorker();
    const client = new NetworkSimClient(worker);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    client.init({ packageJson: '{}', configJson: '{}', seed: 3 });
    client.play();
    client.setSpeed(4);
    client.setDemand('n1', 600);
    client.pause();
    worker.onmessage?.({ data: { type: 'ready', timeStep: 0.1, signalGroupIds: [], entries: ['n1'] } } as unknown as MessageEvent<FromNetworkWorker>);
    worker.onerror?.({ message: '' } as ErrorEvent);

    expect(worker.sent.map((m) => m.type)).toEqual(['init', 'play', 'speed', 'demand', 'pause']);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
    expect(listener).toHaveBeenCalledWith({ type: 'error', message: 'Simulation worker failed' });

    unsubscribe();
    client.dispose();
    expect(worker.sent.at(-1)).toEqual({ type: 'dispose' });
    expect(worker.terminated).toBe(true);
  });
});
