import { commands } from "../app/bindings";

/** Stops the step capture under way and opens its guide. */
export function stopSteps(): Promise<void> {
  return commands.stepsBarStop();
}
