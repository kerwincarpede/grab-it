import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type ScrollBarState_Serialize as ScrollBarState } from "../app/bindings";

export type { ScrollBarState };

/** Mirrors `STATE_EVENT` in src-tauri/src/scroll_bar.rs. */
export const SCROLL_BAR_STATE_EVENT = "scroll-bar-state";

/** The bar's latest state, for a page that loads after it was sent. */
export async function scrollBarState(): Promise<ScrollBarState | null> {
  return (await commands.scrollBarState()) ?? null;
}

/** Calls `handler` with each new state the capture sends. */
export function onScrollBarState(handler: (state: ScrollBarState) => void): Promise<UnlistenFn> {
  return listen<ScrollBarState>(SCROLL_BAR_STATE_EVENT, (event) => handler(event.payload));
}

/** Saves the stitched image. */
export function finishScroll(sessionId: number): Promise<void> {
  return commands.scrollDone(sessionId);
}

/** Throws the stitched image away. */
export function cancelScroll(sessionId: number): Promise<void> {
  return commands.scrollCancel(sessionId);
}
