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
 * placed by a transform and a width, so it moves rather than jumps.
 *
 * Every mode button has a label, open only on the picked one. The labels'
 * widths are set here, so the old one closes as the new one opens, with
 * the pill's own timing (see `.overlay-mode-label`). The pill goes straight
 * to where the picked button ends up once they finish: as measured now,
 * the labels have only begun to move, and nothing renders again while the
 * pointer rests on the toolbar to correct it. It is measured after every
 * render; `picked` names it for tests and styles.
 */
function Slider({ label, picked, children }: { label: string; picked: string | null; children: ReactNode }) {
  const group = useRef<HTMLDivElement>(null);
  const slide = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = slide.current;
    const box = group.current;
    if (!pill || !box) return;
    pill.dataset.picked = picked ?? "";
    const labels = [...box.querySelectorAll<HTMLElement>(".overlay-mode-label")];
    // Each label's width once it has opened or closed.
    const ends = new Map<HTMLElement, number>();
    for (const each of labels) {
      const open = each.dataset.open === "true";
      const end = open ? (each.firstElementChild?.getBoundingClientRect().width ?? 0) : 0;
      ends.set(each, end);
      each.style.width = `${end}px`;
    }
    const button = box.querySelector<HTMLElement>('[data-picked="true"]');
    if (!button) {
      pill.style.opacity = "0";
      return;
    }
    // How far a label still has to go, read after its new width is set:
    // it is still where it was, as its transition has only just begun.
    const still = (each: HTMLElement | null) => (each ? (ends.get(each) ?? 0) - each.getBoundingClientRect().width : 0);
    // The button sits in its tooltip's anchor, so its place is the anchor's.
    const anchor = (button.parentElement as HTMLElement | null) ?? button;
    let left = anchor.getBoundingClientRect().left - box.getBoundingClientRect().left;
    for (const each of labels) {
      if (anchor.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_PRECEDING) left += still(each);
    }
    const width = button.getBoundingClientRect().width + still(button.querySelector(".overlay-mode-label"));
    pill.style.opacity = "1";
    pill.style.width = `${width}px`;
    pill.style.transform = `translateX(${left}px)`;
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
 * mode's take, both ways, while the new mode's own controls fade in and
 * settle. Contents that change width during the fold, as a mode's own
 * controls can once they load, send it on to their new width. The width is
 * set only for the fold and cleared after it, so the controls size
 * themselves the rest of the time. Under reduced motion only the contents
 * fade (see overlay.css).
 */
function Fold({
  mode,
  className,
  testId = "overlay-fold",
  children,
}: {
  mode: string;
  /** Another class beside `overlay-fold`, for a fold elsewhere than the mode's controls. */
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const fold = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const shown = useRef(mode);
  // The fold's end, kept across renders: the toolbar re-renders often
  // (pointer moves, the loupe, the microphone level) while a fold runs.
  const ending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(ending.current), []);
  useLayoutEffect(() => {
    const element = fold.current;
    if (!element || !contents.current) return;
    const from = width.current;
    // The contents' own box, which sizes itself: the fold's scrollWidth
    // would count the hidden tooltips that reach past the last control.
    const to = contents.current.getBoundingClientRect().width;
    width.current = to;
    const end = () => {
      window.clearTimeout(ending.current);
      ending.current = window.setTimeout(() => {
        element.dataset.folding = "false";
        element.style.width = "";
      }, FOLD_MS + 40);
    };
    if (shown.current === mode) {
      // Mid-fold, the contents changed width: carry on to the new one.
      if (element.dataset.folding === "true" && from !== to) {
        element.style.width = `${to}px`;
        end();
      }
      return;
    }
    shown.current = mode;
    if (from === to || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    element.dataset.folding = "true";
    element.style.width = `${from}px`;
    // Laid out at the old width first, so the change animates.
    void element.offsetWidth;
    element.style.width = `${to}px`;
    end();
  });
  return (
    <div className={className ? `overlay-fold ${className}` : "overlay-fold"} ref={fold} data-testid={testId} data-mode={mode}>
      <div className="overlay-fold-contents" ref={contents}>
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
            {/* Sized by Slider; its inner span is the label's full width. */}
            <span className="overlay-mode-label" data-open={picked ? "true" : "false"} aria-hidden="true">
              <span>{label}</span>
            </span>
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
          </button>
        )}
      </Tipped>
    );
  }

  // Record's countdown is in Recording options; key 8 still steps it.
  const timerButton =
    showTimer && !recording ? (
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
            {timer > 0 && <span>{timer} s</span>}
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
            {/* Capture and Record share their targets, which stay put between them. */}
            {hasTargets && (
              <div className="overlay-fold-part">
                <span className="overlay-toolbar-gap" aria-hidden="true" />
                <Slider label={recording ? "What to record" : "What to capture"} picked={pickedTarget}>
                  {TARGETS.map(targetButton)}
                </Slider>
              </div>
            )}
            {/* Keyed by mode, so a new mode's own controls fade in afresh. */}
            {middle && (
              <div className="overlay-toolbar-middle overlay-fold-part" data-testid="overlay-toolbar-middle" key={mode}>
                {middle}
              </div>
            )}
          </Fold>
          <div className="overlay-toolbar-group overlay-toolbar-actions" role="group" aria-label="Actions">
            {/* Capture's alone: it folds in and out with the mode, and as its label changes. */}
            <Fold mode={timerButton ? `timer-${timer}` : "none"} className="overlay-timer-fold" testId="overlay-timer-fold">
              {timerButton && <div className="overlay-fold-part">{timerButton}</div>}
            </Fold>
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
                  {/* Its width eases from one label to the next as the mode changes. */}
                  <Fold mode={`${recording}-${mainLabel}`} className="overlay-main-fold" testId="overlay-main-fold">
                    {recording && <span className="overlay-setup-dot" aria-hidden="true" />}
                    <span className="overlay-main-label" key={mainLabel}>
                      {mainLabel}
                    </span>
                  </Fold>
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
