import { useEffect, useState, type RefObject } from "react";
import { shotThumbnail } from "./api";

/* Thumbnails load only when their tile nears the viewport, a few at a time,
   and stay cached as blob URLs so scrolling back, refreshing the list or
   opening the details panel never fetches the same bytes twice. */

/** Thumbnail requests in flight at once; more queue up. */
const MAX_IN_FLIGHT = 6;
/** Cached thumbnails kept once nothing shows them. */
const MAX_UNUSED = 600;

interface Entry {
  url: string | null;
  failed: boolean;
  /** Mounted thumbnails showing this entry; an entry in use is never evicted. */
  users: number;
  promise: Promise<void> | null;
  listeners: Set<() => void>;
}

const cache = new Map<string, Entry>();
interface Job {
  key: string;
  id: number;
  cancelled: boolean;
}
const queue: Job[] = [];
let inFlight = 0;

function entryFor(key: string): Entry {
  let entry = cache.get(key);
  if (!entry) {
    entry = { url: null, failed: false, users: 0, promise: null, listeners: new Set() };
    cache.set(key, entry);
  } else {
    // Map order doubles as recency for eviction.
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function evict() {
  let unused = 0;
  for (const entry of cache.values()) if (entry.users === 0) unused += 1;
  for (const [key, entry] of cache) {
    if (unused <= MAX_UNUSED) break;
    if (entry.users > 0 || entry.promise) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(key);
    unused -= 1;
  }
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    // Newest request first: what the user scrolled to last is what they see.
    const job = queue.pop() as Job;
    if (job.cancelled) continue;
    const entry = cache.get(job.key);
    if (!entry) continue;
    inFlight += 1;
    entry.promise = shotThumbnail(job.id)
      .then((bytes) => {
        if (typeof URL.createObjectURL !== "function") return;
        entry.url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      })
      .catch(() => {
        entry.failed = true;
      })
      .finally(() => {
        entry.promise = null;
        inFlight -= 1;
        entry.listeners.forEach((listener) => listener());
        pump();
        evict();
      });
  }
}

/** Drops every cached thumbnail; for tests. */
export function resetThumbnails() {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
  queue.length = 0;
  inFlight = 0;
}

/**
 * A shot's thumbnail as a blob URL, fetched once `wanted` turns true.
 * `key` changes when the shot's file does, so an edited capture refreshes.
 */
export function useThumbnail(id: number, key: string, wanted: boolean): { url: string | null; failed: boolean } {
  const [, rerender] = useState(0);
  const entry = entryFor(key);

  useEffect(() => {
    const current = entryFor(key);
    current.users += 1;
    const listener = () => rerender((count) => count + 1);
    current.listeners.add(listener);
    return () => {
      current.users -= 1;
      current.listeners.delete(listener);
    };
  }, [key]);

  useEffect(() => {
    const current = entryFor(key);
    if (!wanted || current.url || current.failed || current.promise) return;
    const job: Job = { key, id, cancelled: false };
    queue.push(job);
    pump();
    return () => {
      // Scrolled away before its turn: skip it.
      job.cancelled = true;
    };
  }, [id, key, wanted]);

  return { url: entry.url, failed: entry.failed };
}

type Callback = (visible: boolean) => void;
const observers = new Map<string, { observer: IntersectionObserver; callbacks: Map<Element, Callback> }>();

/** One shared IntersectionObserver per margin, rather than one per tile. */
function observe(element: Element, rootMargin: string, callback: Callback): () => void {
  let shared = observers.get(rootMargin);
  if (!shared) {
    const callbacks = new Map<Element, Callback>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const item of entries) callbacks.get(item.target)?.(item.isIntersecting);
      },
      { rootMargin },
    );
    shared = { observer, callbacks };
    observers.set(rootMargin, shared);
  }
  const { observer, callbacks } = shared;
  callbacks.set(element, callback);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer.unobserve(element);
  };
}

/**
 * Whether the element is on screen or within `rootMargin` of it. Without
 * IntersectionObserver (tests, very old engines) everything counts as visible.
 */
export function useInView(ref: RefObject<Element | null>, rootMargin = "600px"): boolean {
  const supported = typeof IntersectionObserver === "function";
  const [visible, setVisible] = useState(!supported);
  useEffect(() => {
    const element = ref.current;
    if (!supported || !element) return;
    return observe(element, rootMargin, setVisible);
  }, [ref, rootMargin, supported]);
  return visible;
}
