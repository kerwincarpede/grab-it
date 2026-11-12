/** The view a window shows, picked from its URL hash (`index.html#/settings`). */
export type Route = "settings" | "home";

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  switch (path) {
    case "settings":
      return "settings";
    default:
      return "home";
  }
}
