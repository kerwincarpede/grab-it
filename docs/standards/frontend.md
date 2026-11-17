# Frontend standards

These apply to `src/grab-it/src/`: React, TypeScript (strict) and Vite.

## Structure

- Every window is a route in `routes.ts` and has its own folder: `library/`, `editor/`, `pin/` and so on. A window's component, its `api.ts`, its CSS and its tests stay in that folder.
- `src/app/` holds what more than one window shares. Move code there only when a second window needs it.
- Put pure logic (geometry, history, parsing) in its own `.ts` module with its own tests, apart from the component.

## Talking to Rust

- Only a folder's `api.ts` calls `invoke`. Components call the typed functions it exports.
- An interface that mirrors a Rust struct says so: `/** Mirrors \`PinInfo\` in src-tauri/src/pin.rs. */`. Change both sides in the same PR.
- Command names are the Rust function names (`pin_zoom`). Argument keys are camelCase, as Tauri expects.

## Styling

- Colours come from the tokens in `App.css` (`--bg`, `--text`, `--accent` and so on). Those tokens are redefined for dark mode. Never hard-code a colour that has a token, and check new UI in both light and dark.
- Each window's stylesheet builds on the shared tokens. It does not redefine them.
- Anything that follows the pointer is moved with `transform` and has no transition. Under `prefers-reduced-motion`, use `transition: none`. See the overlay notes in [development.md](../development.md).

## Tests

- Vitest with Testing Library. Test files sit beside the code as `*.test.ts(x)`.
- Fake the backend with `mockIPC` from `@tauri-apps/api/mocks`, and assert on the commands and payloads the page sends. `src/test/setup.ts` clears mocks after each test.
- Test what a user does and sees (role, label, text), not component internals.
- `npm run lint` runs ESLint and `tsc --noEmit`. Both must pass with no `any` or disabled rules left behind.
