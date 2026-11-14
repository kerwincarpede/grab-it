import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DATE_PRESETS, dateFilterLabel, parseTags } from "./api";
import { CalendarIcon, CheckIcon, ChevronIcon, CloseIcon } from "./icons";

/** Closes a popover on a click outside `root` while `open`. */
function useOutsideClick(root: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [root, open, close]);
}

interface ChipSelectProps {
  /** The accessible name, e.g. "Filter by app". */
  label: string;
  icon: ReactNode;
  /** What the chip says with nothing chosen, e.g. "All apps". */
  allLabel: string;
  value: string;
  options: string[];
  /** How an option is shown; the value itself by default. */
  format?: (value: string) => string;
  onChange: (value: string) => void;
}

const asIs = (value: string) => value;

/** A pill that opens a searchable list; "" means any. */
export function ChipSelect({ label, icon, allLabel, value, options, format = asIs, onChange }: ChipSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const close = useMemo(() => () => setOpen(false), []);
  useOutsideClick(root, open, close);

  // Keeps the current choice listed even if no capture has it any more.
  const all = useMemo(() => (value && !options.includes(value) ? [value, ...options] : options), [value, options]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = needle ? all.filter((option) => format(option).toLowerCase().includes(needle)) : all;
    return ["", ...matches];
  }, [all, filter, format]);
  const searchable = all.length > 7;

  function show() {
    setFilter("");
    setActive(Math.max(0, shown.indexOf(value)));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    (searchable ? filterBox.current : list.current)?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function choose(option: string) {
    onChange(option);
    setOpen(false);
    button.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(shown.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
        break;
      case "Enter":
        event.preventDefault();
        if (shown[active] !== undefined) choose(shown[active]);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div className="chip-menu" ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={button}
        type="button"
        className={`chip${value ? " chip-on" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        {icon}
        <span className="chip-text">{value ? format(value) : allLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="popover">
          {searchable && (
            <input
              ref={filterBox}
              type="search"
              className="popover-filter"
              aria-label={`Find in ${label.toLowerCase()}`}
              placeholder="Type to filter…"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setActive(0);
              }}
            />
          )}
          <div
            ref={list}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            className="popover-list"
            aria-activedescendant={`${baseId}-${active}`}
          >
            {shown.map((option, index) => (
              <div
                key={option || "\u0000all"}
                id={`${baseId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option === value}
                className={`popover-option${index === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="popover-option-text">{option ? format(option) : allLabel}</span>
                {option === value && <CheckIcon />}
              </div>
            ))}
            {shown.length === 1 && filter && <div className="popover-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

interface DateChipProps {
  fromDate: string;
  toDate: string;
  onChange: (range: { fromDate: string; toDate: string }) => void;
}

/** A pill for the capture date: quick presets or a custom range. */
export function DateChip({ fromDate, toDate, onChange }: DateChipProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useOutsideClick(root, open, close);
  // Presets are relative to when the menu was last opened.
  const [now, setNow] = useState(Date.now);
  const label = dateFilterLabel(fromDate, toDate, now);

  function pick(range: { fromDate: string; toDate: string }) {
    onChange(range);
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div
      className="chip-menu"
      ref={root}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`chip${label ? " chip-on" : ""}`}
        aria-label="Filter by date"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setNow(Date.now());
          setOpen((value) => !value);
        }}
      >
        <CalendarIcon />
        <span className="chip-text">{label ?? "Any time"}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          className="popover popover-dates"
          role="dialog"
          aria-label="Filter by date"
        >
          <div className="preset-grid">
            {[{ id: "any", label: "Any time", range: () => ({ fromDate: "", toDate: "" }) }, ...DATE_PRESETS].map(
              (preset) => {
                const range = preset.range(now);
                const on = range.fromDate === fromDate && range.toDate === toDate;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`preset${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => pick(range)}
                  >
                    {preset.label}
                  </button>
                );
              },
            )}
          </div>
          <div className="popover-heading">Custom range</div>
          <div className="date-range">
            <label>
              <span>From</span>
              <input
                type="date"
                aria-label="Captured from"
                value={fromDate}
                max={toDate || undefined}
                onChange={(event) => onChange({ fromDate: event.target.value, toDate })}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                aria-label="Captured to"
                value={toDate}
                min={fromDate || undefined}
                onChange={(event) => onChange({ fromDate, toDate: event.target.value })}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
}

/** Tags as removable chips; type and press Enter or comma to add. */
export function TagEditor({ tags, onChange }: TagEditorProps) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function commit(text = draft) {
    setDraft("");
    const known = new Set(tags.map((tag) => tag.toLowerCase()));
    const added: string[] = [];
    for (const tag of parseTags(text)) {
      if (known.has(tag.toLowerCase())) continue;
      known.add(tag.toLowerCase());
      added.push(tag);
    }
    if (added.length > 0) onChange([...tags, ...added]);
  }

  return (
    <div className="tag-editor" onClick={() => input.current?.focus()}>
      {tags.map((tag) => (
        <span key={tag} className="tag tag-editable">
          {tag}
          <button
            type="button"
            className="tag-remove"
            aria-label={`Remove tag ${tag}`}
            onClick={(event) => {
              event.stopPropagation();
              onChange(tags.filter((item) => item !== tag));
            }}
          >
            <CloseIcon size={11} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id="shot-tags"
        value={draft}
        placeholder={tags.length ? "Add…" : "Add a tag…"}
        autoComplete="off"
        onChange={(event) => {
          const text = event.target.value;
          if (text.includes(",")) commit(text);
          else setDraft(text);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => commit()}
      />
    </div>
  );
}
