import { useId, type ReactElement } from "react";

/** What a tooltip says: the item's name, its key here, its global shortcut and its use. */
export interface TipText {
  name: string;
  /** The key in this toolbar. */
  keyLabel?: string;
  /** The global shortcut, already formatted for this platform. */
  global?: string;
  use: string;
}

/**
 * An item with a tooltip that shows on hover and on keyboard focus. The
 * tooltip describes the item, so screen readers read it too. Shared by
 * Capture & record's toolbar and the Record overlay's setup toolbar.
 */
export function Tipped({ tip, children }: { tip: TipText; children: (describedBy: string) => ReactElement }) {
  const id = useId();
  return (
    <span className="overlay-tip-anchor">
      {children(id)}
      <span id={id} role="tooltip" className="overlay-tip">
        <span className="overlay-tip-head">
          <strong>{tip.name}</strong>
          {tip.keyLabel && <kbd>{tip.keyLabel}</kbd>}
        </span>
        {tip.global && <span className="overlay-tip-global">{tip.global} from anywhere</span>}
        <span className="overlay-tip-use">{tip.use}</span>
      </span>
    </span>
  );
}
