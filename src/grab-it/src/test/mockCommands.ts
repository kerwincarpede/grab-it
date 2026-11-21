import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { MockCommandHandlers } from "../app/bindings";

/** `libraryOpenWith` to `library_open_with`: the generated accessor back to its Rust name. */
type SnakeCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCase<Tail>}`
  : S;

/** The generated commands, by Rust command name. */
type TypedCommands = {
  [K in keyof MockCommandHandlers as SnakeCase<K & string>]: MockCommandHandlers[K];
};

/**
 * The byte commands (`BYTE_COMMANDS` in src-tauri/src/lib.rs). Specta cannot
 * describe them, so they are typed by hand: the image ones return the bytes,
 * the others take a raw request body.
 */
type ByteCommands = {
  quick_thumbnail: () => ArrayBuffer;
  pin_image: () => ArrayBuffer;
  overlay_image: () => ArrayBuffer;
  editor_image: () => ArrayBuffer;
  editor_backdrop_image: (args: { path: string }) => ArrayBuffer;
  editor_asset_image: (args: { name: string }) => ArrayBuffer;
  library_thumbnail: (args: { id: number }) => ArrayBuffer;
  library_image: (args: { id: number }) => ArrayBuffer;
  guide_image: (args: { capture: string }) => ArrayBuffer;
  editor_pin: (args: InvokeArgs) => null;
  editor_copy: (args: InvokeArgs) => null;
  editor_export: (args: InvokeArgs) => null;
  library_save_thumbnail: (args: InvokeArgs) => null;
  recording_export: (args: InvokeArgs) => string;
};

type Commands = TypedCommands & ByteCommands;

/** A Rust command the page can call. */
export type CommandName = keyof Commands;

/** What `command` receives: its arguments, camelCased as Tauri sends them. */
export type CommandArgs<C extends CommandName> = Parameters<Commands[C]> extends [infer Args]
  ? Args
  : undefined;

/** What `command` returns when it succeeds. */
export type CommandResult<C extends CommandName> = Awaited<ReturnType<Commands[C]>>;

/** A fake for each command a test needs. Throw to make the command fail. */
export type CommandHandlers = {
  [C in CommandName]?: (args: CommandArgs<C>) => CommandResult<C> | Promise<CommandResult<C>>;
};

/** One call the page made, in the order it made them. */
export type CommandCall = { cmd: string; payload?: InvokeArgs };

export type MockCommandsOptions = {
  /** Mock Tauri's events too, as `mockIPC`'s option of the same name. */
  shouldMockEvents?: boolean;
  /**
   * Answers any command without a handler, such as a plugin's. Without it,
   * such a call fails, so a test cannot pass on a backend it never set up.
   */
  otherwise?: (cmd: string, payload?: InvokeArgs) => unknown;
};

/**
 * Fakes the backend over `mockIPC`, with each handler's arguments and result
 * typed from the Rust command of the same name, so a mock of the wrong shape
 * is a type error. Returns the calls the page made, for tests that assert on
 * them.
 */
export function mockCommands(
  handlers: CommandHandlers,
  { shouldMockEvents, otherwise }: MockCommandsOptions = {},
): CommandCall[] {
  const calls: CommandCall[] = [];
  const byName = new Map<string, (args: unknown) => unknown>(
    Object.entries(handlers) as [string, (args: unknown) => unknown][],
  );
  mockIPC(
    (cmd, payload) => {
      calls.push({ cmd, payload });
      const handler = byName.get(cmd);
      if (handler) return handler(payload);
      if (otherwise) return otherwise(cmd, payload);
      throw new Error(`No mock for the "${cmd}" command`);
    },
    { shouldMockEvents },
  );
  return calls;
}
