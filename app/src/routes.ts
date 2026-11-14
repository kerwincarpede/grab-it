/** The view a window shows, picked from its URL hash (`index.html#/settings`). */
export type Route =
  | "app"
  | "hub"
  | "settings"
  | "overlay"
  | "editor"
  | "recording"
  | "library"
  | "quick"
  | "pin"
  | "welcome"
  | "home";

const ROUTES: readonly Route[] = ["app", "hub", "settings", "overlay", "editor", "recording", "library", "quick", "pin", "welcome"];

/** True when `flag` follows the route in the hash (`#/overlay?instant`). */
export function routeHasFlag(hash: string, flag: string): boolean {
  const query = hash.split("?")[1] ?? "";
  return query.split("&").includes(flag);
}

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return ROUTES.find((route) => route === path) ?? "home";
}
