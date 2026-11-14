import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { EditorClient } from '../editor/useEditorSession';
import { useEditorSession, useHistoryShortcuts, type EditorSession } from '../editor/useEditorSession';
import type { EditorMode } from '../editor/components/EditorToolbar';
import { drawShortcut, isTextInput } from '../editor/shortcuts';
import { useRoadDraft, type RoadDraft } from '../editor/useRoadDraft';
import type { EditScope } from '../editor/wayContext';
import type { PackageIndex } from '../network/inspect';
import type { NetworkPackage } from '../network/types';
import { EditorOverlay } from '../scene/EditorOverlay';
import type { NetworkScene } from '../scene/NetworkScene';

export interface NetworkEditor {
  session: EditorSession;
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  scope: EditScope;
  setScope: (scope: EditScope) => void;
  draft: RoadDraft;
  finishRoad: () => void;
}

export interface NetworkEditorOptions {
  sceneRef: RefObject<NetworkScene | null>;
  index: PackageIndex | null;
  client: EditorClient;
  enabled: boolean;
  showPackage: (pkg: NetworkPackage, keepCamera: boolean) => void;
}

/** Wires the editor session, road drawing tool and keyboard shortcuts to the 3D scene (glue only). */
export function useNetworkEditor({ sceneRef, index, client, enabled, showPackage }: NetworkEditorOptions): NetworkEditor {
  const session = useEditorSession({ client, onDisplay: showPackage });
  const [mode, setMode] = useState<EditorMode>('select');
  const [scope, setScope] = useState<EditScope>('part');
  const draft = useRoadDraft();
  const overlay = useRef<EditorOverlay | null>(null);
  const drawing = enabled && mode === 'draw';

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !enabled) return;
    overlay.current = new EditorOverlay(scene);
    return () => {
      overlay.current?.dispose();
      overlay.current = null;
    };
  }, [sceneRef, enabled]);

  useEffect(() => overlay.current?.setDraft(drawing ? draft.points : []), [drawing, draft.points]);

  const { add } = draft;
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setClickHandler(
      drawing && index
        ? ({ ground }) => {
            if (ground) add(index, ground);
            return true;
          }
        : null,
    );
    return () => scene.setClickHandler(null);
  }, [sceneRef, drawing, index, add]);

  const finishRoad = useCallback(() => {
    if (index) draft.finish(index, session.changeset, session.apply);
  }, [draft, index, session.changeset, session.apply]);

  useHistoryShortcuts(enabled, session.undo, session.redo);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!enabled || !session.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled, session.dirty]);

  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      const action = drawShortcut(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'finish') finishRoad();
      else if (action === 'back') draft.back();
      else if (draft.points.length > 0) draft.cancel();
      else setMode('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, draft, finishRoad]);

  return { session, mode, setMode, scope, setScope, draft, finishRoad };
}
