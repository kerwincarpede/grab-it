import { useMemo } from "react";
import type { Shape } from "./model";
import { useImageResources } from "./useAssetImages";
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

function stampUrls(shapes: Shape[]): string[] {
  const urls = new Set<string>();
  for (const shape of shapes) {
    const url = shape.type === "stamp" ? stampDef(shape.name)?.url : undefined;
    if (url) urls.add(url);
  }
  return [...urls];
}

/** Preloads image stamps before drawing a capture on a hidden stage. */
export async function loadStampImages(shapes: Shape[]): Promise<ReadonlyMap<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(stampUrls(shapes).map(async (url) => {
    const img = await loadStampImage(url);
    if (img) images.set(url, img);
  }));
  return images;
}

export function useStampImages(shapes: Shape[]) {
  const urls = useMemo(() => stampUrls(shapes), [shapes]);
  return useImageResources(urls, loadStampImage);
}
