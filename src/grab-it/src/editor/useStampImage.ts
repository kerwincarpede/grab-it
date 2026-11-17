import { useEffect, useState } from "react";
import type { Shape } from "./model";
import { stampDef } from "./stamps";

/** Bundled stamp images, loaded once each and shared by every stamp that shows them. */
const loaded = new Map<string, HTMLImageElement>();
const loading = new Map<string, Promise<HTMLImageElement | null>>();
/** How long a stamp image may take to load before drawing goes ahead without it. */
const LOAD_TIMEOUT_MS = 5000;

/** Loads a bundled stamp SVG as an image; null when it cannot load. */
export function loadStampImage(url: string): Promise<HTMLImageElement | null> {
  const done = loaded.get(url);
  if (done) return Promise.resolve(done);
  let pending = loading.get(url);
  if (!pending) {
    pending = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      const timer = window.setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
      img.onload = () => {
        window.clearTimeout(timer);
        loaded.set(url, img);
        resolve(img);
      };
      img.onerror = () => {
        window.clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    }).finally(() => loading.delete(url));
    loading.set(url, pending);
  }
  return pending;
}

/** Loads the images of every cursor and emoji stamp in `shapes`, so a drawing made straight after shows them. */
export async function loadStampImages(shapes: Shape[]): Promise<void> {
  const urls = new Set<string>();
  for (const shape of shapes) {
    const url = shape.type === "stamp" ? stampDef(shape.name)?.url : undefined;
    if (url) urls.add(url);
  }
  await Promise.all([...urls].map(loadStampImage));
}

/** A bundled stamp image for drawing; null until it loads, or for a stamp that has none. */
export function useStampImage(url: string | null | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<{ url: string; image: HTMLImageElement } | null>(() => {
    const cached = url ? loaded.get(url) : undefined;
    return url && cached ? { url, image: cached } : null;
  });
  useEffect(() => {
    if (!url || loaded.has(url)) return;
    let cancelled = false;
    void loadStampImage(url).then((img) => {
      if (!cancelled && img) setImage({ url, image: img });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!url) return null;
  return image?.url === url ? image.image : (loaded.get(url) ?? null);
}
