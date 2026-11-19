import { useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CloseIcon, TimerIcon } from "../app/icons";
import type { RecordingSource } from "../settings/api";
import type { CaptureKind } from "../app/api";
import type { Size } from "./geometry";
import { ChipMenu } from "./RecordSetup";
import {
  RATIOS,
  TARGETS,
  TIMER_KEY,
  TOOL_ITEMS,
  TOOLS,
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
  /** The main button's label, named for the mode. */
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
  /** The middle section: size and ratios, the colour, or nothing. */
  middle: ReactNode;
  barRef: Ref<HTMLDivElement>;
  onTool: (tool: Tool) => void;
  onSource: (source: RecordingSource) => void;
  onTimer: () => void;
  onCountdown: () => void;
  onMain: () => void;
  onCancel: () => void;
}

/**
 * Capture & record's one toolbar, in the recording toolbar's look: what to
 * capture (1 to 3), the tools (4 to 7), a middle section that changes with
 * the state, the Timer (8), the main button named for the mode, and Cancel.
 * Every item has a tooltip. It never follows the pointer.
 *
 * With Record on, Region, Window and Screen pick what to record, Record
 * keeps its red dot, the middle holds the recording options, the Timer's
 * place is the countdown and the main button is a red Record.
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
  barRef,
  onTool,
  onSource,
  onTimer,
  onCountdown,
  onMain,
  onCancel,
}: ChooserToolbarProps) {
  const compact = layout !== "wide";
  const recording = source !== null;

  function modeButton({ tool: each, label, icon, hotkey, use }: ToolInfo) {
    const key = TOOLS.findIndex((info) => info.tool === each) + 1;
    // In Record, the targets say what to record; their global shortcuts take screenshots.
    const target = recording ? SOURCES.find((info) => info.source === each) : undefined;
    const picked = target ? target.source === source : each === tool;
    const tip = target
      ? { name: label, keyLabel: String(key), use: target.use }
      : {
          name: label,
          keyLabel: String(key),
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
            aria-label={label}
            aria-describedby={describedBy}
            // Screen captures at once, so it is a toggle only for a recording.
            aria-pressed={each === "screen" && !target ? undefined : picked}
            aria-keyshortcuts={String(key)}
            onClick={() => (target ? onSource(target.source) : onTool(each))}
          >
            {icon}
            {(!compact || picked) && <span>{label}</span>}
            <kbd aria-hidden="true">{key}</kbd>
          </button>
        )}
      </Tipped>
    );
  }

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
      style={edge === "top" ? { top: offset } : { bottom: offset }}
      // Clicks on buttons leave the focus where it was, so Enter and Space
      // never press the last button again; the fields take it as fields do.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
      onKeyDown={arrowWithinGroup}
    >
      <div className="overlay-toolbar-group" role="group" aria-label={recording ? "What to record" : "What to capture"}>
        {TARGETS.map(modeButton)}
      </div>
      <span className="overlay-toolbar-gap" aria-hidden="true" />
      <div className="overlay-toolbar-group" role="group" aria-label="Tools">
        {TOOL_ITEMS.map(modeButton)}
      </div>
      {middle && (
        <div className="overlay-toolbar-middle" data-testid="overlay-toolbar-middle">
          {middle}
        </div>
      )}
      <div className="overlay-toolbar-group overlay-toolbar-actions" role="group" aria-label="Actions">
        {recording && countdown !== null && (
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
        )}
        {showTimer && !recording && (
          <Tipped
            tip={{ name: "Timer", keyLabel: String(TIMER_KEY), use: "Waits off, 3, 5 or 10 s before capturing." }}
          >
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
        )}
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
    </div>
  );
}
