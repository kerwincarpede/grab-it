import { useId, useState, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { CloseIcon, TimerIcon } from "../app/icons";
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
  type TipText,
  type Tool,
  type ToolInfo,
  type ToolbarLayout,
} from "./chooser";

/**
 * An item with a tooltip that shows on hover and on keyboard focus. The
 * tooltip describes the item, so screen readers read it too.
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
  /** Shown at all: the Timer for screenshots, the main button outside Record. */
  showTimer: boolean;
  /** The main button's label, or null where it has none (Record, for now). */
  mainLabel: string | null;
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
  onTimer: () => void;
  onMain: () => void;
  onCancel: () => void;
}

/**
 * Capture & record's one toolbar, in the recording toolbar's look: what to
 * capture (1 to 3), the tools (4 to 7), a middle section that changes with
 * the state, the Timer (8), the main button named for the mode, and Cancel.
 * Every item has a tooltip. It never follows the pointer.
 */
export function ChooserToolbar({
  tool,
  timer,
  showTimer,
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
  onTimer,
  onMain,
  onCancel,
}: ChooserToolbarProps) {
  const compact = layout !== "wide";

  function modeButton({ tool: each, label, icon, hotkey, use }: ToolInfo) {
    const key = TOOLS.findIndex((info) => info.tool === each) + 1;
    const picked = each === tool;
    return (
      <Tipped
        key={each}
        tip={{ name: label, keyLabel: String(key), global: hotkey ? globals[hotkey] : undefined, use }}
      >
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool overlay-mode"
            data-tool={each}
            aria-label={label}
            aria-describedby={describedBy}
            aria-pressed={each === "screen" ? undefined : picked}
            aria-keyshortcuts={String(key)}
            onClick={() => onTool(each)}
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
      <div className="overlay-toolbar-group" role="group" aria-label="What to capture">
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
        {showTimer && (
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
        {mainLabel !== null && (
          <Tipped tip={{ name: mainLabel, keyLabel: "Enter", use: mainUse }}>
            {(describedBy) => (
              <button
                type="button"
                className="overlay-main"
                data-testid="overlay-confirm"
                aria-disabled={ready ? undefined : "true"}
                aria-describedby={describedBy}
                aria-keyshortcuts="Enter"
                onClick={() => {
                  if (ready) onMain();
                }}
              >
                <span>{mainLabel}</span>
                <kbd aria-hidden="true">↵</kbd>
              </button>
            )}
          </Tipped>
        )}
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
