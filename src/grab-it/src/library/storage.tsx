import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  STORAGE_KINDS,
  formatSize,
  libraryStorage,
  storageTotal,
  type LibraryStorage,
  type ShotKind,
} from "./api";
import { useOutsideClick } from "./useOutsideClick";

const kindColor = (kind: ShotKind) => `var(--kind-${kind})`;

/** "7%": a share of `total`, rounded. */
function share(part: number, total: number): string {
  return `${total > 0 ? Math.round((part / total) * 100) : 0}%`;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

interface RingProps {
  storage: LibraryStorage;
  /** The viewBox's width and height. */
  size: number;
  radius: number;
  width: number;
  /** The space left between arcs. */
  gap: number;
  className?: string;
  onArcEnter?: (kind: ShotKind, event: MouseEvent<SVGCircleElement>) => void;
  onArcLeave?: () => void;
}

/** A ring with one arc per kind, as long as its share of the library. */
function Ring({ storage, size, radius, width, gap, className, onArcEnter, onArcLeave }: RingProps) {
  const total = storageTotal(storage);
  const circumference = 2 * Math.PI * radius;
  const centre = size / 2;
  const parts = STORAGE_KINDS.filter(({ kind }) => storage[kind].bytes > 0);
  let offset = 0;
  return (
    <svg className={className} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle className="storage-track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={width} />
      {parts.map(({ kind }) => {
        const length = (storage[kind].bytes / total) * circumference;
        const arc = Math.max(length - (parts.length > 1 ? gap : 0), 0.5);
        const start = offset;
        offset += length;
        return (
          <circle
            key={kind}
            className="storage-arc"
            data-kind={kind}
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={width}
            strokeDasharray={`${arc} ${circumference}`}
            strokeDashoffset={-start}
            transform={`rotate(-90 ${centre} ${centre})`}
            style={{ stroke: kindColor(kind) }}
            onMouseEnter={onArcEnter && ((event) => onArcEnter(kind, event))}
            onMouseMove={onArcEnter && ((event) => onArcEnter(kind, event))}
            onMouseLeave={onArcLeave}
          />
        );
      })}
    </svg>
  );
}

/** The donut in the popover, with the total in its middle and a tooltip per arc. */
function Donut({ storage }: { storage: LibraryStorage }) {
  const [tip, setTip] = useState<{ kind: ShotKind; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const total = storageTotal(storage);
  const label = STORAGE_KINDS.map(({ kind, name }) => `${name} ${formatSize(storage[kind].bytes)}`).join(", ");
  const tipKind = tip && STORAGE_KINDS.find(({ kind }) => kind === tip.kind);
  return (
    <div className="storage-donut" ref={box} role="img" aria-label={`Storage by type: ${label}`}>
      <Ring
        storage={storage}
        size={136}
        radius={56}
        width={16}
        gap={3}
        onArcEnter={(kind, event) => {
          const rect = box.current?.getBoundingClientRect();
          setTip({ kind, x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
        }}
        onArcLeave={() => setTip(null)}
      />
      <div className="storage-donut-centre">
        <b>{formatSize(total)}</b>
        <span>used</span>
      </div>
      {tip && tipKind && (
        <div className="storage-tip" role="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <b>
            {tipKind.name} · {formatSize(storage[tip.kind].bytes)}
          </b>
          <span>
            {plural(storage[tip.kind].count, tipKind.one, tipKind.many)} · {share(storage[tip.kind].bytes, total)} of
            the library
          </span>
        </div>
      )}
    </div>
  );
}

/** The save folder's disk: the library's kinds, then everything else on it. */
function DiskMeter({ storage }: { storage: LibraryStorage }) {
  const { disk } = storage;
  if (!disk || disk.total <= 0) return null;
  const total = storageTotal(storage);
  const other = Math.max(0, disk.total - disk.free - total);
  const parts = [
    ...STORAGE_KINDS.map(({ kind, name }) => ({ key: kind, name, bytes: storage[kind].bytes, color: kindColor(kind) })),
    { key: "other", name: "Other files", bytes: other, color: "var(--storage-other)" },
  ].filter((part) => part.bytes > 0);
  return (
    <div className="storage-disk">
      <div className="storage-disk-top">
        <span>This disk</span>
        <span>
          <b>{formatSize(total)}</b> of {formatSize(disk.total)} · {formatSize(disk.free)} free
        </span>
      </div>
      <div
        className="storage-meter"
        role="meter"
        aria-label="Grab-it's share of this disk"
        aria-valuemin={0}
        aria-valuemax={disk.total}
        aria-valuenow={total}
        aria-valuetext={`${formatSize(total)} of ${formatSize(disk.total)}, ${formatSize(disk.free)} free`}
      >
        {parts.map((part) => (
          <i
            key={part.key}
            title={`${part.name} · ${formatSize(part.bytes)}`}
            style={{ width: `${Math.max((part.bytes / disk.total) * 100, 0.8)}%`, background: part.color }}
          />
        ))}
      </div>
    </div>
  );
}

interface StoragePillProps {
  /** How many items the Library lists. */
  count: number;
  /** Changes whenever the library may have changed, to measure it again. */
  version: number;
}

/**
 * The count of items and their size, with a small ring by kind, that opens
 * the Storage popover. Until the size is known, or when it cannot be read,
 * just the count.
 */
export function StoragePill({ count, version }: StoragePillProps) {
  const [storage, setStorage] = useState<LibraryStorage | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useOutsideClick(root, open, close);

  useEffect(() => {
    let cancelled = false;
    libraryStorage()
      .then((found) => {
        if (!cancelled) setStorage(found);
      })
      .catch(() => {
        // Without sizes the pill still says how many items there are.
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const countText = count === 1 ? "1 capture" : `${count} captures`;
  if (!storage) return <span className="count-pill">{countText}</span>;
  const total = storageTotal(storage);

  return (
    <div
      className="storage-menu"
      ref={root}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="storage-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Ring className="storage-ring-mini" storage={storage} size={16} radius={6} width={3} gap={1} />
        <span>{countText}</span>
        <span aria-hidden="true">·</span>
        <b>{formatSize(total)}</b>
      </button>
      {open && (
        <div className="popover storage-popover" role="dialog" aria-label="Storage">
          <div className="storage-head">
            <h2>Storage</h2>
          </div>
          <div className="storage-body">
            <Donut storage={storage} />
            <ul className="storage-legend" aria-label="Storage by type">
              {STORAGE_KINDS.map(({ kind, name, one, many }) => (
                <li key={kind} className="storage-legend-row">
                  <i className="storage-dot" style={{ background: kindColor(kind) }} aria-hidden="true" />
                  <span className="storage-legend-name">{name}</span>
                  <span className="storage-legend-size">{formatSize(storage[kind].bytes)}</span>
                  <span className="storage-legend-sub">
                    {plural(storage[kind].count, one, many)} · {share(storage[kind].bytes, total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <DiskMeter storage={storage} />
        </div>
      )}
    </div>
  );
}
