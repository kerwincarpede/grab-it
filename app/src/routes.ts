/** The view a window shows, picked from its URL hash (`index.html#/settings`). */
export type Route = "settings" | "overlay" | "editor" | "library" | "quick" | "pin" | "home";

const ROUTES: readonly Route[] = ["settings", "overlay", "editor", "library", "quick", "pin"];

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return ROUTES.find((route) => route === path) ?? "home";
}
