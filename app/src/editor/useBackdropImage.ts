import { useEffect, useState } from "react";
import { backdropImage } from "./api";

/** Loads the image a backdrop is filled with; null until it loads, or when it cannot. */
export function useBackdropImage(path: string | null) {
  const [loaded, setLoaded] = useState<{ path: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!path) return;
    let url: string | null = null;
    let cancelled = false;
    let reading: Promise<ArrayBuffer>;
    try {
      reading = backdropImage(path);
    } catch (err) {
      reading = Promise.reject(err);
    }
    reading
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes]));
        const img = new Image();
        img.onload = () => !cancelled && setLoaded({ path, image: img });
        img.src = url;
      })
      // A moved or unreadable image leaves the plain underlay showing.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return loaded && loaded.path === path ? loaded.image : null;
}
