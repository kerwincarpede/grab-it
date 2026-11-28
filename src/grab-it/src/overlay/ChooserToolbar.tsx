import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CheckIcon, CloseIcon, TimerIcon } from "../app/icons";
import type { RecordingSource } from "../settings/api";
import type { CaptureKind } from "../app/api";
import type { Size } from "./geometry";
import { ChipMenu } from "./RecordSetup";
import {
  MODES,
  modeOf,
  RATIOS,
  TARGETS,
  TIMER_KEY,
  TOOLS,
  type ModeInfo,
  type RatioId,
  type Tool,
  type ToolInfo,
  type ToolbarLayout,
} from "./chooser";

import { COUNTDOWN_USE, countdownText } from "./recordOptions";
import { SOURCES } from "./recordSources";
import { Tipped } from "./Tipped";

/** A typed size: a whole number of image pixels, at least one. */
function parseLength(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
}

interface SizeFieldsProps {
  /** The selection's size in image pixels. */
  size: Size;
  ratio: RatioId;
  /** The ratios as one menu, for a narrow display. */
  folded: boolean;
  /** Menus open above, for a toolbar at the bottom edge. */
  up: boolean;
  onSize: (size: Size) => void;
  onRatio: (ratio: RatioId) => void;
}

/**
 * A held selection's width and height in image pixels, which take an exact
 * size, and the ratio presets.
 */
export function SizeFields({ size, ratio, folded, up, onSize, onRatio }: SizeFieldsProps) {
  // What is being typed, until Enter or leaving the field applies it.
  const [draft, setDraft] = useState<{ width: string; height: string } | null>(null);
  const shown = draft ?? { width: String(size.width), height: String(size.height) };

  function apply() {
    if (!draft) return;
    setDraft(null);
    const width = parseLength(draft.width);
    const height = parseLength(draft.height);
    if (width === null || height === null) return;
    if (width !== size.width || height !== size.height) onSize({ width, height });
  }

  function field(side: "width" | "height", label: string) {
    return (
      <Tipped tip={{ name: label, use: `Type an exact ${side} in pixels, then press Enter.` }}>
        {(describedBy) => (
          <input
            className="overlay-size-input"
            type="text"
            inputMode="numeric"
            aria-label={label}
            aria-describedby={describedBy}
            data-testid={`overlay-size-${side}`}
            value={shown[side]}
            onChange={(event) => setDraft({ ...shown, [side]: event.target.value })}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Enter here sets the size; it only captures from outside the field.
              event.preventDefault();
              event.stopPropagation();
              apply();
            }}
          />
        )}
      </Tipped>
    );
  }

  const current = RATIOS.find((each) => each.id === ratio) ?? RATIOS[0];
  return (
    <>
      {field("width", "Width")}
      <span aria-hidden="true">×</span>
      {field("height", "Height")}
      <span className="overlay-size-unit">px</span>
      <span className="overlay-toolbar-gap" aria-hidden="true" />
      {folded ? (
        <ChipMenu
          title="Aspect ratio"
          up={up}
          checks
          tip={{ name: "Aspect ratio", use: "Keeps the selection at a shape, or Free for any." }}
          label={current.label}
          options={RATIOS.map(({ id, label }) => ({
            key: id,
            title: label,
            selected: id === ratio,
            onPick: () => onRatio(id),
          }))}
        />
      ) : (
        <div className="overlay-ratios" role="group" aria-label="Aspect ratio">
          {RATIOS.map(({ id, label }) => (
            <Tipped
              key={id}
              tip={{ name: label, use: id === "free" ? "Any shape." : `Keeps the selection at ${label}.` }}
            >
              {(describedBy) => (
                <button
                  type="button"
                  className="overlay-tool overlay-ratio"
                  aria-pressed={id === ratio}
                  aria-describedby={describedBy}
                  onClick={() => onRatio(id)}
                >
                  {label}
                </button>
              )}
            </Tipped>
          ))}
        </div>
      )}
    </>
  );
}

/** Moves the focus to the next or previous button in the same group, round the ends. */
function arrowWithinGroup(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLButtonElement)) return;
  const group = target.closest('[role="group"]');
  if (!group) return;
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.closest('[role="group"]') === group && !button.disabled,
  );
  const at = buttons.indexOf(target);
  if (at < 0) return;
  event.preventDefault();
  const step = event.key === "ArrowRight" ? 1 : -1;
  buttons[(at + step + buttons.length) % buttons.length].focus();
}

/**
 * A group with one highlight that slides under its picked button: a pill
 * placed by a transform and a width, so it moves rather than jumps. It is
 * measured after every render, as the picked button's label changes its
 * width; `picked` names it for tests and styles.
 */
function Slider({ label, picked, children }: { label: string; picked: string | null; children: ReactNode }) {
  const group = useRef<HTMLDivElement>(null);
  const slide = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = slide.current;
    const button = group.current?.querySelector<HTMLElement>('[data-picked="true"]');
    if (!pill) return;
    pill.dataset.picked = picked ?? "";
    if (!button) {
      pill.style.opacity = "0";
      return;
    }
    // The button sits in its tooltip's anchor, so its place is the anchor's.
    const anchor = (button.parentElement as HTMLElement | null) ?? button;
    pill.style.opacity = "1";
    pill.style.width = `${button.offsetWidth}px`;
    pill.style.transform = `translateX(${anchor.offsetLeft}px)`;
  });
  return (
    <div className="overlay-toolbar-group overlay-slider" role="group" aria-label={label} ref={group}>
      <span className="overlay-slide" aria-hidden="true" ref={slide} data-testid="overlay-slide" />
      {children}
    </div>
  );
}

/**
 * A mode's own controls, which fold open and closed as the mode changes:
 * the width goes from what the last mode's controls took to what this
 * mode's take, both ways, while the new contents fade in and settle. The
 * width is set only for the fold and cleared after it, so the controls
 * size themselves the rest of the time. Under reduced motion only the
 * contents fade (see overlay.css).
 */
function Fold({ mode, children }: { mode: string; children: ReactNode }) {
  const fold = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const shown = useRef(mode);
  // The fold's end, kept across renders: the toolbar re-renders often
  // (pointer moves, the loupe, the microphone level) while a fold runs.
  const ending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(ending.current), []);
  useLayoutEffect(() => {
    const element = fold.current;
    if (!element) return;
    const from = width.current;
    const to = element.scrollWidth;
    width.current = to;
    if (shown.current === mode) return;
    shown.current = mode;
    if (from === to || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    window.clearTimeout(ending.current);
    element.dataset.folding = "true";
    element.style.width = `${from}px`;
    // Laid out at the old width first, so the change animates.
    void element.offsetWidth;
    element.style.width = `${to}px`;
    ending.current = window.setTimeout(() => {
      element.dataset.folding = "false";
      element.style.width = "";
    }, FOLD_MS + 40);
  });
  return (
    <div className="overlay-fold" ref={fold} data-testid="overlay-fold" data-mode={mode}>
      {/* Keyed by mode, so a new mode's contents fade in afresh. */}
      <div className="overlay-fold-contents" key={mode}>
        {children}
      </div>
    </div>
  );
}

/** How long a fold takes, in ms; matches `.overlay-fold`'s transition. */
export const FOLD_MS = 220;

export interface ChooserToolbarProps {
  tool: Tool;
  timer: number;
  /** The Timer is shown: for screenshots. */
  showTimer: boolean;
  /**
   * While Record is on: what to record, which keys 1 to 3 and Region,
   * Window and Screen pick. Null outside Record.
   */
  source: RecordingSource | null;
  /** Record's countdown in seconds, in the Timer's place on 8; null until it is known. */
  countdown: number | null;
  /** The main button's label, named for its action. */
  mainLabel: string;
  /** The main button can act; dimmed until then, its tooltip says what to do first. */
  ready: boolean;
  /** What the main button's tooltip says. */
  mainUse: string;
  /** Each mode's global shortcut as the desktop registered it, by capture kind. */
  globals: Partial<Record<CaptureKind, string>>;
  layout: ToolbarLayout;
  edge: "top" | "bottom";
  /** Pixels from that edge. */
  offset: number;
  hidden: boolean;
  /** The mode's own controls: the recording options, the colour, or nothing. */
  middle: ReactNode;
  /**
   * What was just done, such as Copied: the toolbar shows a tick and this
   * in place of its controls until the overlay closes. Null until then.
   */
  done?: string | null;
  barRef: Ref<HTMLDivElement>;
  onTool: (tool: Tool) => void;
  onSource: (source: RecordingSource) => void;
  onTimer: () => void;
  onCountdown: () => void;
  onMain: () => void;
  onCancel: () => void;
}

/**
 * Capture & record's one toolbar, in the recording toolbar's look: the
 * five modes (Capture, Record, Text, Colour and Scroll) with one highlight
 * that slides between them and the active mode's label, then that mode's
 * own controls folding in: Region, Window and Screen for Capture and
 * Record, the recording options, the colour, the Timer (8) or countdown.
 * Then the main button named for its action, and Cancel. Every item has a
 * tooltip. It never follows the pointer.
 *
 * Keys 1 to 3 pick a target (Capture's, or Record's), 4 to 7 the other
 * modes, as before the modes were grouped.
 */
export function ChooserToolbar({
  tool,
  timer,
  showTimer,
  source,
  countdown,
  mainLabel,
  ready,
  mainUse,
  globals,
  layout,
  edge,
  offset,
  hidden,
  middle,
  done = null,
  barRef,
  onTool,
  onSource,
  onTimer,
  onCountdown,
  onMain,
  onCancel,
}: ChooserToolbarProps) {
  const recording = source !== null;
  const mode = modeOf(tool);
  const hasTargets = mode === "capture" || mode === "record";
  const pickedTarget = recording ? source : hasTargets ? tool : null;

  function modeButton({ mode: each, label, icon, hotkey, use }: ModeInfo) {
    const key = each === "capture" ? 1 : TOOLS.findIndex((info) => info.tool === each) + 1;
    const picked = each === mode;
    const tip = {
      name: label,
      keyLabel: each === "capture" ? "1–3" : String(key),
      global: hotkey ? globals[hotkey] : undefined,
      use: each === "record" && recording ? `${use} Press ${key} again for screenshots.` : use,
    };
    return (
      <Tipped key={each} tip={tip}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool overlay-mode"
            data-tool={each}
            data-picked={picked ? "true" : "false"}
            aria-label={label}
            aria-describedby={describedBy}
            aria-pressed={picked}
            aria-keyshortcuts={String(key)}
            onClick={() => {
              // Record again goes back to screenshots; any other picked mode stays.
              if (picked && each !== "record") return;
              onTool(each === "capture" ? "region" : each);
            }}
          >
            {icon}
            {picked && <span className="overlay-mode-label">{label}</span>}
          </button>
        )}
      </Tipped>
    );
  }

  function targetButton({ tool: each, label, icon, hotkey, use }: ToolInfo) {
    const key = TOOLS.findIndex((info) => info.tool === each) + 1;
    // In Record, the targets say what to record; their global shortcuts take screenshots.
    const target = recording ? SOURCES.find((info) => info.source === each) : undefined;
    const picked = each === pickedTarget;
    const tip = target
      ? { name: label, keyLabel: String(key), use: target.use }
      : { name: label, keyLabel: String(key), global: hotkey ? globals[hotkey] : undefined, use };
    return (
      <Tipped key={each} tip={tip}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool overlay-mode overlay-target"
            data-tool={each}
            data-picked={picked ? "true" : "false"}
            aria-label={label}
            aria-describedby={describedBy}
            // Screen captures at once, so it is a toggle only for a recording.
            aria-pressed={each === "screen" && !target ? undefined : picked}
            aria-keyshortcuts={String(key)}
            onClick={() => (target ? onSource(target.source) : onTool(each))}
          >
            {icon}
            <kbd aria-hidden="true">{key}</kbd>
          </button>
        )}
      </Tipped>
    );
  }

  const timerButton =
    recording && countdown !== null ? (
      <Tipped tip={{ name: "Countdown", keyLabel: String(TIMER_KEY), use: COUNTDOWN_USE }}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool"
            data-testid="overlay-countdown"
            aria-label={countdownText(countdown).label}
            aria-describedby={describedBy}
            aria-pressed={countdown > 0}
            aria-keyshortcuts={String(TIMER_KEY)}
            onClick={onCountdown}
          >
            <TimerIcon />
            <span>{countdownText(countdown).text}</span>
            <kbd aria-hidden="true">{TIMER_KEY}</kbd>
          </button>
        )}
      </Tipped>
    ) : showTimer && !recording ? (
      <Tipped tip={{ name: "Timer", keyLabel: String(TIMER_KEY), use: "Waits off, 3, 5 or 10 s before capturing." }}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool"
            data-testid="overlay-timer"
            aria-label={timer > 0 ? `Timer ${timer} s` : "Timer off"}
            aria-describedby={describedBy}
            aria-pressed={timer > 0}
            aria-keyshortcuts={String(TIMER_KEY)}
            onClick={onTimer}
          >
            <TimerIcon />
            <span>{timer > 0 ? `${timer} s` : "Timer"}</span>
            <kbd aria-hidden="true">{TIMER_KEY}</kbd>
          </button>
        )}
      </Tipped>
    ) : null;

  return (
    <div
      ref={barRef}
      className="overlay-toolbar"
      role="toolbar"
      aria-label="Capture & record"
      data-testid="overlay-toolbar"
      data-hidden={hidden ? "true" : "false"}
      data-layout={layout}
      data-edge={edge}
      data-mode={mode}
      data-done={done !== null ? "true" : undefined}
      style={edge === "top" ? { top: offset } : { bottom: offset }}
      // Clicks on buttons leave the focus where it was, so Enter and Space
      // never press the last button again; the fields take it as fields do.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
      onKeyDown={arrowWithinGroup}
    >
      {done !== null ? (
        <div className="overlay-toolbar-done" data-testid="overlay-toolbar-done" role="status">
          <span className="overlay-done-tick" aria-hidden="true">
            <CheckIcon size={16} />
          </span>
          <span>{done}</span>
        </div>
      ) : (
        <>
          <Slider label="Modes" picked={mode}>
            {MODES.map(modeButton)}
          </Slider>
          <Fold mode={mode}>
            {hasTargets && (
              <>
                <span className="overlay-toolbar-gap" aria-hidden="true" />
                <Slider label={recording ? "What to record" : "What to capture"} picked={pickedTarget}>
                  {TARGETS.map(targetButton)}
                </Slider>
              </>
            )}
            {middle && (
              <div className="overlay-toolbar-middle" data-testid="overlay-toolbar-middle">
                {middle}
              </div>
            )}
          </Fold>
          <div className="overlay-toolbar-group overlay-toolbar-actions" role="group" aria-label="Actions">
            {timerButton}
            <Tipped tip={{ name: mainLabel, keyLabel: "Enter", use: mainUse }}>
              {(describedBy) => (
                <button
                  type="button"
                  className="overlay-main"
                  data-testid="overlay-confirm"
                  data-tone={recording ? "record" : undefined}
                  aria-disabled={ready ? undefined : "true"}
                  aria-describedby={describedBy}
                  aria-keyshortcuts="Enter"
                  onClick={() => {
                    if (ready) onMain();
                  }}
                >
                  {recording && <span className="overlay-setup-dot" aria-hidden="true" />}
                  <span>{mainLabel}</span>
                  <kbd aria-hidden="true">↵</kbd>
                </button>
              )}
            </Tipped>
            <Tipped tip={{ name: "Cancel", keyLabel: "Esc", use: "Closes the chooser without capturing." }}>
              {(describedBy) => (
                <button
                  type="button"
                  className="overlay-tool overlay-setup-icon"
                  aria-label="Cancel"
                  aria-describedby={describedBy}
                  aria-keyshortcuts="Escape"
                  onClick={onCancel}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </Tipped>
          </div>
        </>
      )}
    </div>
  );
}
