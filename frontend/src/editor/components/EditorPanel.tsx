import type { PackageIndex } from '../../network/inspect';
import type { PickTarget } from '../../network/meshData';
import { selectedLink, selectedNodeId } from '../selection';
import type { EditorSession } from '../useEditorSession';
import type { EditScope } from '../wayContext';
import { JunctionTools } from './JunctionTools';
import { LinkTools } from './LinkTools';

export interface EditorPanelProps {
  index: PackageIndex;
  target: PickTarget | null;
  session: EditorSession;
  scope: EditScope;
  onScope: (scope: EditScope) => void;
}

/** Edit tools for the selected road or junction. */
export function EditorPanel({ index, target, session, scope, onScope }: EditorPanelProps) {
  const link = selectedLink(index, target);
  const nodeId = selectedNodeId(index, target);
  if (!link && !nodeId) return null;
  const title = link ? `Edit road ${link.name ?? link.id}` : `Edit junction ${nodeId}`;
  return (
    <section className="editor-panel" aria-label="Edit tools">
      <header className="inspector-header">
        <h2>{title}</h2>
      </header>
      {link && (
        <>
          <div className="segmented" role="radiogroup" aria-label="Apply edits to">
            <button type="button" role="radio" aria-checked={scope === 'part'} onClick={() => onScope('part')}>
              This part
            </button>
            <button type="button" role="radio" aria-checked={scope === 'way'} onClick={() => onScope('way')}>
              Whole road
            </button>
          </div>
          <LinkTools
            key={link.id}
            index={index}
            link={link}
            laneIndex={target?.kind === 'lane' ? target.laneIndex : null}
            changeset={session.changeset}
            scope={scope}
            apply={session.apply}
          />
        </>
      )}
      {nodeId && <JunctionTools key={nodeId} index={index} nodeId={nodeId} changeset={session.changeset} apply={session.apply} replace={session.replace} />}
    </section>
  );
}
