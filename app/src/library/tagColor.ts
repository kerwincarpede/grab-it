import type { CSSProperties } from "react";

/**
 * Hues tags are tinted with: distinct from each other and readable in light
 * and dark mode. The stylesheets turn `--tag-hue` into text and fill colours.
 */
export const TAG_HUES = [220, 265, 320, 100, 28, 45, 145, 185] as const;

/** A tag's hue: the same for the same tag everywhere, whatever its case. */
export function tagHue(tag: string): number {
  // FNV-1a: cheap, and spreads short similar names across the palette.
  let hash = 0x811c9dc5;
  for (const char of tag.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return TAG_HUES[(hash >>> 0) % TAG_HUES.length];
}

/** Inline style that tints a tag chip with its hue. */
export const tagStyle = (tag: string) => ({ "--tag-hue": tagHue(tag) }) as CSSProperties;
