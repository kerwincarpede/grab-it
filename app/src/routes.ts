/** The view a window shows, picked from its URL hash (`index.html#/settings`). */
export type Route = "settings" | "overlay" | "home";

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  switch (path) {
    case "settings":
      return "settings";
    case "overlay":
      return "overlay";
    default:
      return "home";
  }
}
