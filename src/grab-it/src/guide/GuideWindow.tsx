import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { Image as KonvaImage, Layer, Stage } from "react-konva";
import "./guide.css";
import ShapeNode from "../editor/ShapeNode";
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
  const doc = useMemo(() => numbered(step.annotations, number), [step.annotations, number]);
  const badges = useMemo(() => stepNumbers(doc.shapes), [doc.shapes]);

  useEffect(() => {
    if (!image || !layer.current) return;
    let cancelled = false;
    let url: string | null = null;
    const size = { width: image.naturalWidth, height: image.naturalHeight };
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
  }, [image, doc, step.capture, onFlattened]);

  return (
    <li className="guide-step">
      <div className="guide-step-number" aria-hidden="true">
        {number}
      </div>
      <div className="guide-step-image">
        {thumb ? (
          <img src={thumb} alt={`Step ${number}`} />
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
          <button type="button" className="btn btn-small btn-danger" onClick={onDelete} aria-label={`Delete step ${number}`}>
            Delete
          </button>
        </div>
      </div>
      {image && (
        // Drawn off screen at capture size, for flattening.
        <div className="guide-step-stage" aria-hidden="true">
          <Stage width={image.naturalWidth} height={image.naturalHeight} listening={false}>
            <Layer ref={layer}>
              <KonvaImage image={image} />
              {doc.shapes.map((shape) => (
                <ShapeNode key={shape.id} shape={shape} image={image} step={badges.get(shape.id)} editable={false} onSelect={noop} onChange={noop} onEditText={noop} />
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
    const unlisten = onGuideChanged(() => {
      guideInfo()
        .then((info) => setSteps((current) => current && mergeDescriptions(current, info.steps, edited.current)))
        .catch(() => {});
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const onFlattened = useCallback((capture: string, png: Uint8Array) => {
    flattened.current.set(capture, png);
  }, []);

  const persist = useCallback((next: GuideStep[]) => {
    setSteps(next);
    saveGuide(savedSteps(next)).catch((err: unknown) => setError(String(err)));
  }, []);

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
              onDelete={() => persist(removeStep(steps, index))}
            />
          ))}
        </ol>
      )}
    </main>
  );
}
