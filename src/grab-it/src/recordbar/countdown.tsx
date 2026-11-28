import "./countdown.css";

/** The ring's circumference: 2π × its radius of 9.5 in a 24-unit box. */
const RING = 59.7;

interface RingProps {
  /** Whole seconds left. */
  left: number;
  /** Whole seconds the countdown began with. */
  total: number;
  /** Red for a recording, blue for a timed capture. */
  tone: "record" | "capture";
}

/**
 * A ring that empties over each second of a countdown, as in the toolbar
 * prototype: the stroke runs on to where the next second leaves it.
 */
export function CountdownRing({ left, total, tone }: RingProps) {
  const span = Math.max(total, 1);
  const offset = RING * (1 - Math.max(left - 1, 0) / span);
  return (
    <svg className="bar-ring" data-tone={tone} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle className="bar-ring-bg" cx="12" cy="12" r="9.5" />
      <circle className="bar-ring-fg" cx="12" cy="12" r="9.5" strokeDasharray={RING} strokeDashoffset={offset} />
    </svg>
  );
}

/** A number that rolls up to its next value, keyed so each change animates in. */
export function Rolling({ value, label }: { value: number; label: string }) {
  return (
    <span className="bar-roll" role="timer" aria-label={label}>
      <span key={value}>{value}</span>
    </span>
  );
}
