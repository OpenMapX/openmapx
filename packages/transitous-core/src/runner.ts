/**
 * Minimal command-runner abstraction shared by the CLI seed path and the
 * data-manager daemon. Both pass a function that ultimately shells out (execa /
 * docker run); keeping the type here lets the shared helpers stay agnostic.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
) => Promise<void>;

/** Minimal logger shared helpers emit through (matches the daemon JobLogger). */
export interface TransitousLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
