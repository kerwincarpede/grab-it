/** The view a window shows, picked from its URL hash (`index.html#/settings`). */
export type Route =
  | "app"
  | "hub"
  | "settings"
  | "overlay"
  | "editor"
  | "library"
  | "quick"
  | "pin"
  | "welcome"
  | "home";

const ROUTES: readonly Route[] = ["app", "hub", "settings", "overlay", "editor", "library", "quick", "pin", "welcome"];

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return ROUTES.find((route) => route === path) ?? "home";
}
