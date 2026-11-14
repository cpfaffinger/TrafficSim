import { describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from './protocol';
import { SimClient, type WorkerLike } from './simClient';

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: ToWorker): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  receive(data: FromWorker): void {
    this.onmessage?.({ data } as MessageEvent<FromWorker>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('SimClient', () => {
  it('sends commands to the worker', () => {
    const worker = new FakeWorker();
    const client = new SimClient(worker);

    client.init({ vehicleCount: 22, length: 230, heterogeneity: 0, seed: 1 });
    client.play();
    client.setSpeed(5);
    client.perturb();
    client.pause();

    expect(worker.sent.map((m) => m.type)).toEqual(['init', 'play', 'speed', 'perturb', 'pause']);
    expect(worker.sent[3]).toEqual({ type: 'perturb', vehicle: 0, speedFactor: 0.2 });
  });

  it('forwards worker messages to subscribers until they unsubscribe', () => {
    const worker = new FakeWorker();
    const client = new SimClient(worker);
    const listener = vi.fn();

    const unsubscribe = client.subscribe(listener);
    worker.receive({ type: 'ready', vehicleCount: 22, timeStep: 0.1 });
    unsubscribe();
    worker.receive({ type: 'ready', vehicleCount: 22, timeStep: 0.1 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports worker errors as error messages', () => {
    const worker = new FakeWorker();
    const client = new SimClient(worker);
    const listener = vi.fn();
    client.subscribe(listener);

    worker.fail('');

    expect(listener).toHaveBeenCalledWith({ type: 'error', message: 'Simulation worker failed' });
  });

  it('terminates the worker on dispose', () => {
    const worker = new FakeWorker();
    new SimClient(worker).dispose();
    expect(worker.terminated).toBe(true);
  });
});
