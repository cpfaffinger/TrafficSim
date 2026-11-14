// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesetRejectedError, type Scenario } from '../api/scenarioClient';
import { editorNetwork } from '../test/editorNetwork';
import { EditError, type EditOperation } from './ops';
import { useEditorSession, useHistoryShortcuts, type EditorClient } from './useEditorSession';

const ban: EditOperation = { op: 'ban_movement', nodeId: 100, fromNeighbour: 202, toNeighbour: 301 };
const stop: EditOperation = { op: 'set_node_tags', nodeId: 100, tags: { highway: 'stop' } };

const scenario = (changeset: EditOperation[] = []): Scenario => ({
  id: 's1',
  name: 'A',
  baselineId: 'b1',
  parentId: null,
  changeset,
  demand: null,
  seed: 1,
  durationSeconds: 3600,
  shareToken: 'tok',
  createdAt: '',
  updatedAt: '',
});

function fakeClient(): EditorClient & { [K in keyof EditorClient]: ReturnType<typeof vi.fn> } {
  const pkg = editorNetwork();
  return {
    preview: vi.fn().mockResolvedValue({ pkg, issues: [] }),
    getScenarioPackage: vi.fn().mockResolvedValue({ pkg, issues: [{ operationIndex: 0, operation: 'BanMovement', message: 'gone' }] }),
    createScenario: vi.fn().mockImplementation((input: { changeset: EditOperation[] }) => Promise.resolve(scenario(input.changeset))),
    updateScenario: vi.fn().mockImplementation((_id: string, input: { changeset: EditOperation[] }) => Promise.resolve(scenario(input.changeset))),
  };
}

function setup(client = fakeClient()) {
  const onDisplay = vi.fn();
  const hook = renderHook(() => useEditorSession({ client, onDisplay, debounceMs: 100 }));
  act(() => hook.result.current.startBaseline(editorNetwork(), 'b1'));
  return { client, onDisplay, hook, session: () => hook.result.current };
}

const flush = async (ms = 150) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useEditorSession', () => {
  it('debounces previews of edits and keeps the camera', async () => {
    const { client, onDisplay, session } = setup();
    act(() => void session().apply(() => ({ label: 'Ban', ops: [ban] })));
    act(() => void session().apply(() => ({ label: 'Stop', ops: [stop] })));
    expect(session().preview).toBe('pending');
    expect(session().dirty).toBe(true);
    await flush();
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(client.preview.mock.calls[0]![1]).toEqual([ban, stop]);
    expect(onDisplay).toHaveBeenCalledWith(expect.objectContaining({ formatVersion: 1 }), true);
    expect(session().preview).toBe('idle');
  });

  it('shows the baseline again when all edits are undone', async () => {
    const { client, onDisplay, session } = setup();
    act(() => void session().apply(() => ({ label: 'Ban', ops: [ban] })));
    await flush();
    act(() => session().undo());
    expect(session().changeset).toEqual([]);
    expect(onDisplay).toHaveBeenCalledTimes(2);
    expect(client.preview).toHaveBeenCalledTimes(1);
    act(() => session().redo());
    await flush();
    expect(client.preview).toHaveBeenCalledTimes(2);
  });

  it('reports edit errors instead of throwing', () => {
    const { session } = setup();
    let ok = true;
    act(() => {
      ok = session().apply(() => {
        throw new EditError('Not possible');
      });
    });
    expect(ok).toBe(false);
    expect(session().error).toBe('Not possible');
    act(() => session().clearError());
    expect(session().error).toBeNull();
    expect(() =>
      session().apply(() => {
        throw new TypeError('bug');
      }),
    ).toThrow(TypeError);
  });

  it('reports preview failures', async () => {
    const client = fakeClient();
    client.preview.mockRejectedValue(new Error('offline'));
    const { session } = setup(client);
    act(() => void session().apply(() => ({ label: 'Ban', ops: [ban] })));
    await flush();
    expect(session().preview).toBe('error');
    expect(session().error).toBe('Preview failed: offline');
  });

  it('creates a scenario on first save, then updates it', async () => {
    const { client, session } = setup();
    act(() => void session().apply(() => ({ label: 'Ban', ops: [ban] })));
    await act(async () => void (await session().save('My variant')));
    expect(client.createScenario).toHaveBeenCalledWith({ name: 'My variant', baselineId: 'b1', changeset: [ban] });
    expect(session().scenario?.id).toBe('s1');
    expect(session().dirty).toBe(false);
    act(() => void session().apply(() => ({ label: 'Stop', ops: [stop] })));
    await act(async () => void (await session().save()));
    expect(client.updateScenario).toHaveBeenCalledWith('s1', { changeset: [ban, stop] });
  });

  it('shows rejected edits when saving fails', async () => {
    const client = fakeClient();
    client.createScenario.mockRejectedValue(new ChangesetRejectedError('1 edit', [{ operationIndex: 0, operation: 'BanMovement', message: 'node missing' }]));
    const { session } = setup(client);
    let result: Scenario | null = scenario();
    await act(async () => {
      result = await session().save();
    });
    expect(result).toBeNull();
    expect(session().error).toBe('Not saved: 1 edit');
    expect(session().issues[0]!.message).toBe('node missing');
  });

  it('opens scenarios with their changeset and package', async () => {
    const { client, onDisplay, session } = setup();
    await act(async () => session().openScenario(scenario([ban])));
    expect(client.getScenarioPackage).toHaveBeenCalledWith('s1');
    expect(session().changeset).toEqual([ban]);
    expect(session().dirty).toBe(false);
    expect(session().issues).toHaveLength(1);
    expect(onDisplay).toHaveBeenCalledTimes(1);
    await flush();
    expect(client.preview).not.toHaveBeenCalled();
    act(() => session().replace('Allow', []));
    expect(session().dirty).toBe(true);
    act(() => session().setScenario(null));
    expect(session().scenario).toBeNull();
    expect(session().dirty).toBe(false);
    client.getScenarioPackage.mockRejectedValueOnce(new Error('404'));
    await act(async () => session().openScenario(scenario()));
    expect(session().error).toBe('Could not open “A”: 404');
  });

  it('does not save without a baseline', async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useEditorSession({ client, onDisplay: vi.fn() }));
    expect(await result.current.save()).toBeNull();
  });
});

describe('useHistoryShortcuts', () => {
  it('undoes and redoes from the keyboard, but not while typing', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { unmount } = renderHook(() => useHistoryShortcuts(true, onUndo, onRedo));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    const input = document.body.appendChild(document.createElement('input'));
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
