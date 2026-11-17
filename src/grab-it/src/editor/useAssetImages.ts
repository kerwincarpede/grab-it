import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetImage } from "./api";
import type { Shape } from "./model";

/** Decodes image bytes into an element; rejects when they are not an image. */
export function loadImageBytes(bytes: ArrayBuffer): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image"));
    };
    img.src = url;
  });
}

/** Reads an added image from the capture's assets folder and decodes it. */
export async function loadAssetImage(name: string): Promise<HTMLImageElement> {
  return loadImageBytes(await assetImage(name));
}

/**
 * The elements of the images added to the capture, by `src`, as
 * useBackdropImage loads the backdrop's. Each file is read once; one that is
 * missing or unreadable is left out, so its shape draws nothing.
 * `seed` lets a just-added image be shown without reading it again, and
 * `ready` resolves once every image the shapes name has loaded or failed,
 * and the editor has drawn it, so Copy and Export never leave one out.
 */
export function useAssetImages(shapes: Shape[]) {
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef(new Set<string>());
  const srcs = useMemo(
    () => [...new Set(shapes.flatMap((shape) => (shape.type === "image" ? [shape.src] : [])))],
    [shapes],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const src of srcs) {
      if (requested.current.has(src)) continue;
      requested.current.add(src);
      let reading: Promise<HTMLImageElement>;
      try {
        reading = loadAssetImage(src);
      } catch (err) {
        reading = Promise.reject(err);
      }
      reading
        .then((img) => {
          if (mounted.current) setImages((current) => new Map(current).set(src, img));
        })
        // A missing or unreadable image draws nothing.
        .catch(() => {
          if (mounted.current) setFailed((current) => new Set(current).add(src));
        });
    }
  }, [srcs]);
  const pending = srcs.some((src) => !images.has(src) && !failed.has(src));
  // Read by `ready`, which outlives the render that made it.
  const pendingRef = useRef(pending);
  const waiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
    if (pending) return;
    // Effects run after the commit, so the loaded images are on the layer by now.
    const waiting = waiters.current;
    waiters.current = [];
    for (const resolve of waiting) resolve();
  }, [pending]);
  const ready = useCallback(
    (): Promise<void> => (pendingRef.current ? new Promise((resolve) => waiters.current.push(resolve)) : Promise.resolve()),
    [],
  );
  const seed = useCallback((src: string, img: HTMLImageElement) => {
    requested.current.add(src);
    setImages((current) => new Map(current).set(src, img));
  }, []);
  return { images, seed, ready };
}
