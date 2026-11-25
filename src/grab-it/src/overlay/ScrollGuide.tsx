import { commands } from "../app/bindings";
import { CheckIcon } from "../app/icons";

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
  /** Starts the capture of the held area: Start scrolling or Enter. */
  onStart: () => void;
  /** Closes Capture & record and opens the Scrolling capture docs page. */
  onDocs: () => void;
}

/** The Scrolling capture page on the docs site. */
export const SCROLL_DOCS_URL = "https://kerwincarpede.github.io/grab-it/capture/scrolling/";

const STEPS: { title: string; sub: string; optional?: true }[] = [
  { title: "Click a window or drag over an area", sub: "Pick the part of the screen that scrolls." },
  {
    title: "Trim the edges",
    sub: "Fixed headers and sidebars are fine. They appear once, at the top.",
    optional: true,
  },
  { title: "Start", sub: "Choose Start scrolling or press Enter." },
];

/** What happens once the capture starts, for each choice of who scrolls. */
const WHAT_HAPPENS: Record<"auto" | "byHand", readonly string[]> = {
  auto: [
    "Starts from what's on screen now and scrolls down. Not at the top? Press Esc, scroll up, and start again.",
    "Hands off the mouse and trackpad. Moving them hands scrolling to you.",
    "Stops at the end and saves on its own.",
  ],
  byHand: [
    "Starts from what's on screen now.",
    "Scroll at a steady pace. If the bar says you went too fast, scroll back a little.",
    "Choose Done on the bar at the top of the screen when you reach the end.",
  ],
};

function Points({ points }: { points: readonly string[] }) {
  return (
    <ul className="scroll-guide-points">
      {points.map((point) => (
        <li key={point}>{point}</li>
      ))}
    </ul>
  );
}

/**
 * Scroll mode's guide: the step the setup is on, who scrolls, what will
 * happen once it starts, and Start scrolling.
 */
export default function ScrollGuide({
  stage,
  byHand,
  onByHand,
  accessibility,
  edge,
  top,
  onStart,
  onDocs,
}: ScrollGuideProps) {
  // Holding an area finishes the first step; trimming it is the current
  // one until the capture starts, and Start follows it.
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
      <header className="scroll-guide-head">
        <h2>Scrolling capture</h2>
        <span className="scroll-guide-esc">
          <kbd>Esc</kbd> to cancel
        </span>
      </header>
      <ol className="scroll-guide-steps">
        {STEPS.map(({ title, sub, optional }, index) => {
          const state = index < current ? "done" : index === current ? "current" : "next";
          return (
            <li key={title} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="scroll-guide-number" aria-hidden={state === "done" ? undefined : "true"}>
                {state === "done" ? (
                  <span role="img" aria-label="Done">
                    <CheckIcon size={12} />
                  </span>
                ) : (
                  index + 1
                )}
              </span>
              <span className="scroll-guide-step">
                <span className="scroll-guide-title">
                  {title}
                  {optional && <span className="scroll-guide-optional">optional</span>}
                </span>
                {state === "current" && <span className="scroll-guide-sub">{sub}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="scroll-guide-who" role="radiogroup" aria-labelledby="scroll-guide-who">
        <span id="scroll-guide-who" className="scroll-guide-label">
          Who scrolls?
        </span>
        <button
          type="button"
          role="radio"
          className="scroll-guide-card"
          aria-checked={!manual}
          aria-labelledby="scroll-guide-auto"
          aria-describedby="scroll-guide-auto-use"
          disabled={blocked}
          onClick={() => onByHand(false)}
        >
          <span id="scroll-guide-auto" className="scroll-guide-card-name">
            Grab-it
          </span>
          <span id="scroll-guide-auto-use" className="scroll-guide-card-use">
            {blocked ? "Needs Accessibility permission." : "Hands-free. Best for most pages."}
          </span>
        </button>
        <button
          type="button"
          role="radio"
          className="scroll-guide-card"
          aria-checked={manual}
          aria-labelledby="scroll-guide-me"
          aria-describedby="scroll-guide-me-use"
          onClick={() => onByHand(true)}
        >
          <span id="scroll-guide-me" className="scroll-guide-card-name">
            Me
          </span>
          <span id="scroll-guide-me-use" className="scroll-guide-card-use">
            For pages that load more as you scroll, or apps Grab-it can't scroll.
          </span>
        </button>
      </div>
      <section className="scroll-guide-what" aria-labelledby="scroll-guide-what">
        <h3 id="scroll-guide-what" className="scroll-guide-label">
          What happens
        </h3>
        {/* Both lists share one cell, so the panel keeps its height and the
            cards above stay under the pointer when the choice changes. */}
        <div className="scroll-guide-text">
          <div role="status">
            <Points points={manual ? WHAT_HAPPENS.byHand : WHAT_HAPPENS.auto} />
          </div>
          <div className="scroll-guide-spacer" aria-hidden="true">
            <Points points={manual ? WHAT_HAPPENS.auto : WHAT_HAPPENS.byHand} />
          </div>
        </div>
      </section>
      <footer className="scroll-guide-foot">
        <a
          className="scroll-guide-docs"
          href={SCROLL_DOCS_URL}
          onClick={(event) => {
            event.preventDefault();
            onDocs();
          }}
        >
          How scrolling capture works
        </a>
        <button type="button" className="scroll-guide-start" disabled={stage !== "adjust"} onClick={onStart}>
          Start scrolling <kbd>Enter</kbd>
        </button>
      </footer>
      {blocked && (
        <p className="scroll-guide-warning" role="alert">
          <span>Grab-it needs Accessibility permission to scroll for you. Until you allow it, you scroll.</span>
          <button type="button" onClick={() => void commands.accessibilityOpenSettings()}>
            Open Settings
          </button>
        </p>
      )}
    </aside>
  );
}
