import { commands } from "../app/bindings";

/** Where the setup is: nothing held yet, or an area held to adjust and start. */
export type ScrollStage = "choose" | "adjust";

interface ScrollGuideProps {
  stage: ScrollStage;
  /** The user scrolls instead of Grab-it. */
  byHand: boolean;
  onByHand: (byHand: boolean) => void;
  /** Whether Grab-it may scroll for the user; null until known. */
  accessibility: boolean | null;
  /** Under the toolbar, or above the bottom edge when the area is up there. */
  edge: "top" | "bottom";
  top: number;
}

const STEPS: { stage: ScrollStage | "start"; title: string }[] = [
  { stage: "choose", title: "Choose a window, or drag an area" },
  { stage: "adjust", title: "Drag the edges to the part that scrolls" },
  { stage: "start", title: "Press Start scrolling or Enter" },
];

/**
 * Scroll mode's guide: the three steps, what Grab-it will do, and who scrolls.
 */
export default function ScrollGuide({ stage, byHand, onByHand, accessibility, edge, top }: ScrollGuideProps) {
  const current = stage === "choose" ? 0 : 1;
  const blocked = accessibility === false;
  const manual = byHand || blocked;
  return (
    <aside
      className="scroll-guide"
      aria-label="Scrolling capture"
      data-edge={edge}
      style={edge === "top" ? { top } : undefined}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ol className="scroll-guide-steps">
        {STEPS.map(({ stage: step, title }, index) => (
          <li
            key={step}
            data-state={index < current ? "done" : index === current || (current === 1 && index === 2) ? "current" : "next"}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="scroll-guide-number">{index + 1}</span>
            {title}
          </li>
        ))}
      </ol>
      <p className="scroll-guide-text" role="status">
        {manual
          ? "Scroll the page yourself at a steady pace. Grab-it joins what it sees; choose Done on the bar when you reach the end."
          : "Grab-it moves the pointer to the middle of the area and scrolls for you. Leave the mouse and trackpad alone until it finishes. Moving it switches to scrolling by hand: keep scrolling, then choose Done."}
      </p>
      {blocked && (
        <p className="scroll-guide-warning">
          To let Grab-it scroll for you, allow it in Accessibility settings. Until then you scroll by hand.{" "}
          <button type="button" onClick={() => void commands.accessibilityOpenSettings()}>
            Open Settings
          </button>
        </p>
      )}
      <div className="scroll-guide-who" role="radiogroup" aria-label="Who scrolls">
        <button
          type="button"
          role="radio"
          aria-checked={!manual}
          disabled={blocked}
          onClick={() => onByHand(false)}
        >
          Scroll for me
        </button>
        <button type="button" role="radio" aria-checked={manual} onClick={() => onByHand(true)}>
          I’ll scroll myself
        </button>
      </div>
    </aside>
  );
}
