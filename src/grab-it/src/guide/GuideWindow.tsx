import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { Image as KonvaImage, Layer, Stage } from "react-konva";
import "../app/app.css";
import "./guide.css";
import Dialog from "../app/Dialog";
import ShapeNode from "../editor/ShapeNode";
import { joinedImage, joinedSize, validCuts } from "../editor/cut";
import { flatten } from "../editor/flatten";
import { stepNumbers } from "../editor/tools";
import { useOutsideClick } from "../library/useOutsideClick";
import {
  chooseExportPath,
  copyGuide,
  exportGuide,
  guideImage,
  guideInfo,
  onGuideChanged,
  openInEditor,
  saveGuide,
  type ExportStep,
} from "./api";
import {
  EXPORT_FORMATS,
  insertStep,
  mergeDescriptions,
  moveStep,
  numbered,
  readAnnotations,
  removeStep,
  savedSteps,
  toBase64,
  type GuideFormat,
  type GuideStep,
} from "./model";

const noop = () => {};

/** How long the "Step N deleted." toast stays up. */
const TOAST_MS = 8000;

/** True when `target` takes typing, where ⌘ Z / Ctrl Z belongs to the field. */
function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

/** A step taken out of the guide, and where it was, so Undo can put it back. */
interface DeletedStep {
  step: GuideStep;
  index: number;
}

/** Loads a step's capture as an image element. */
function useStepImage(capture: string, exists: boolean) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(!exists);
  useEffect(() => {
    if (!exists) return;
    let url: string | null = null;
    let cancelled = false;
    guideImage(capture)
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const img = new Image();
        img.onload = () => !cancelled && setImage(img);
        img.onerror = () => !cancelled && setFailed(true);
        img.src = url;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [capture, exists]);
  return { image, failed };
}

interface StepCardProps {
  step: GuideStep;
  number: number;
  count: number;
  onFlattened: (capture: string, png: Uint8Array) => void;
  onDescription: (description: string) => void;
  onCommit: () => void;
  onMove: (to: number) => void;
  onDelete: () => void;
}

/**
 * One step: its capture flattened with its annotations, as the editor
 * exports it (so editor edits show), and its editable description.
 */
function StepCard({ step, number, count, onFlattened, onDescription, onCommit, onMove, onDelete }: StepCardProps) {
  const { image, failed } = useStepImage(step.capture, step.exists);
  const layer = useRef<Konva.Layer>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const doc = useMemo(() => numbered(step.annotations, number), [step.annotations, number]);
  const badges = useMemo(() => stepNumbers(doc.shapes), [doc.shapes]);
  /** The capture with the editor's cuts made: shapes and the crop live in its pixels, as in the editor and on export. */
  const joined = useMemo(() => {
    if (!image) return null;
    const original = { width: image.naturalWidth, height: image.naturalHeight };
    const cuts = validCuts(original, doc.cuts);
    return { image: joinedImage(image, cuts), size: joinedSize(original, cuts) };
  }, [image, doc.cuts]);

  useEffect(() => {
    if (!joined || !layer.current) return;
    let cancelled = false;
    let url: string | null = null;
    const size = joined.size;
    const frame = requestAnimationFrame(() => {
      if (!layer.current) return;
      layer.current.draw();
      flatten(layer.current, { crop: doc.crop, scale: doc.scale }, size, { scale: 1, x: 0, y: 0 }, "png")
        .then((png) => {
          if (cancelled) return;
          onFlattened(step.capture, png);
          url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
          setThumb(url);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (url) URL.revokeObjectURL(url);
    };
  }, [joined, doc, step.capture, onFlattened]);

  return (
    <li className="guide-step">
      <div className="guide-step-number" aria-hidden="true">
        {number}
      </div>
      <div className="guide-step-image">
        {thumb ? (
          <button type="button" className="guide-step-view" aria-label={`View step ${number} larger`} onClick={() => setViewing(true)}>
            <img src={thumb} alt="" />
          </button>
        ) : (
          <div className="guide-step-placeholder">{failed ? "Capture not found" : "Loading…"}</div>
        )}
      </div>
      <div className="guide-step-body">
        <label className="guide-step-label" htmlFor={`step-${step.capture}`}>
          Step {number}
        </label>
        <textarea
          id={`step-${step.capture}`}
          className="guide-step-text"
          rows={2}
          value={step.description}
          onChange={(event) => onDescription(event.target.value)}
          onBlur={onCommit}
        />
        <div className="guide-step-actions">
          <button type="button" className="btn btn-small" disabled={number === 1} onClick={() => onMove(number - 2)} aria-label={`Move step ${number} up`}>
            Move up
          </button>
          <button type="button" className="btn btn-small" disabled={number === count} onClick={() => onMove(number)} aria-label={`Move step ${number} down`}>
            Move down
          </button>
          <button type="button" className="btn btn-small" disabled={!step.exists} onClick={() => void openInEditor(step.capture)}>
            Open in editor
          </button>
          <button type="button" className="btn btn-small" onClick={onDelete} aria-label={`Delete step ${number}`}>
            Delete
          </button>
        </div>
      </div>
      {viewing && thumb && (
        <Dialog title={`Step ${number}`} className="guide-view" onClose={() => setViewing(false)}>
          <img className="guide-view-image" src={thumb} alt={`Step ${number}`} />
          {step.description.trim() && <p className="guide-view-text">{step.description.trim()}</p>}
        </Dialog>
      )}
      {joined && (
        // Drawn off screen at the joined capture's size, for flattening.
        <div className="guide-step-stage" aria-hidden="true">
          <Stage width={joined.size.width} height={joined.size.height} listening={false}>
            <Layer ref={layer}>
              <KonvaImage image={joined.image} />
              {doc.shapes.map((shape) => (
                <ShapeNode key={shape.id} shape={shape} image={joined.image} step={badges.get(shape.id)} editable={false} onSelect={noop} onChange={noop} onEditText={noop} />
              ))}
            </Layer>
          </Stage>
        </div>
      )}
    </li>
  );
}

export default function GuideWindow() {
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<GuideStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A new object on every Delete, so the toast's timer starts again.
  const [toast, setToast] = useState<{ number: number } | null>(null);
  const deleted = useRef<DeletedStep[]>([]);
  const flattened = useRef(new Map<string, Uint8Array>());
  const edited = useRef(new Set<string>());
  const menu = useRef<HTMLDivElement>(null);
  useOutsideClick(menu, menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    guideInfo()
      .then((info) => {
        setTitle(info.title);
        setSteps(info.steps.map((step) => ({ ...step, annotations: readAnnotations(step.annotations) })));
      })
      .catch((err: unknown) => setError(String(err)));
    // Stopped at once on unmount, or as soon as it is listening if that
    // comes later.
    let disposed = false;
    let stop: (() => void) | null = null;
    onGuideChanged(() => {
      guideInfo()
        .then((info) => setSteps((current) => current && mergeDescriptions(current, info.steps, edited.current)))
        .catch(() => {});
    })
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const onFlattened = useCallback((capture: string, png: Uint8Array) => {
    flattened.current.set(capture, png);
  }, []);

  const persist = useCallback((next: GuideStep[]) => {
    setSteps(next);
    saveGuide(savedSteps(next)).catch((err: unknown) => setError(String(err)));
  }, []);

  const remove = (index: number) => {
    if (!steps) return;
    deleted.current.push({ step: steps[index], index });
    persist(removeStep(steps, index));
    setToast({ number: index + 1 });
  };

  /** Puts the most recently deleted step back in its place and saves. */
  const undo = useCallback(() => {
    if (!steps) return;
    const last = deleted.current.pop();
    if (!last) return;
    persist(insertStep(steps, last.index, last.step));
    setToast(null);
  }, [steps, persist]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      if (inTextField(event.target) || deleted.current.length === 0) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  /** The steps flattened for export, or null (after saying why) when one is not ready. */
  const exportSteps = useCallback((): ExportStep[] | null => {
    const shown = (steps ?? []).filter((step) => step.exists);
    const ready = shown.map((step) => ({ step, png: flattened.current.get(step.capture) }));
    if (ready.some((entry) => !entry.png)) {
      setError("The steps are still loading. Try again in a moment.");
      return null;
    }
    return ready.map(({ step, png }) => ({ description: step.description.trim(), png: toBase64(png as Uint8Array) }));
  }, [steps]);

  const run = useCallback(async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const done = await work();
      if (done) setNotice(done);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const exportAs = (format: GuideFormat) => {
    setMenuOpen(false);
    void run(async () => {
      const payload = exportSteps();
      if (!payload) return null;
      const path = await chooseExportPath(title, format);
      if (!path) return null;
      await exportGuide(format, path, payload);
      return `Exported to ${path}`;
    });
  };

  const copy = () =>
    void run(async () => {
      const payload = exportSteps();
      if (!payload) return null;
      await copyGuide(payload);
      return "Copied the guide.";
    });

  if (error && !steps) {
    return (
      <main className="window guide">
        <p className="guide-error" role="alert">
          {error}
        </p>
      </main>
    );
  }

  return (
    <main className="window guide">
      <header className="guide-header">
        <h1>{title || "Guide"}</h1>
        <div className="guide-header-actions">
          <button type="button" className="btn" disabled={busy || !steps?.length} onClick={copy}>
            Copy
          </button>
          <div className="guide-menu" ref={menu}>
            <button
              type="button"
              className="btn btn-primary"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy || !steps?.length}
              onClick={() => setMenuOpen((open) => !open)}
            >
              Export
            </button>
            {menuOpen && (
              <div className="guide-menu-list" role="menu">
                {EXPORT_FORMATS.map((entry) => (
                  <button key={entry.format} type="button" role="menuitem" onClick={() => exportAs(entry.format)}>
                    {entry.label} <span className="guide-menu-ext">.{entry.extension}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>
      {error && (
        <p className="guide-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="guide-notice" role="status">
          {notice}
        </p>
      )}
      {steps === null ? (
        <p className="hint">Loading…</p>
      ) : steps.length === 0 ? (
        <p className="hint">This guide has no steps. Deleted steps stay in the Library.</p>
      ) : (
        <ol className="guide-steps">
          {steps.map((step, index) => (
            <StepCard
              key={step.capture}
              step={step}
              number={index + 1}
              count={steps.length}
              onFlattened={onFlattened}
              onDescription={(description) => {
                edited.current.add(step.capture);
                setSteps((current) => current && current.map((entry, at) => (at === index ? { ...entry, description } : entry)));
              }}
              onCommit={() => persist(steps)}
              onMove={(to) => persist(moveStep(steps, index, to))}
              onDelete={() => remove(index)}
            />
          ))}
        </ol>
      )}
      {toast && (
        <div className="guide-toast" role="status">
          <span>Step {toast.number} deleted.</span>
          <button type="button" className="guide-toast-undo" onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </main>
  );
}
