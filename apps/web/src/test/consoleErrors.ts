/**
 * Capture `console.error` calls for a test.
 *
 * Always `restore()` in an `afterEach` — a test that throws before restoring
 * leaves every later test's console swallowed.
 */
export interface CapturedConsoleErrors {
  /** How many times `console.error` has been called since capture started. */
  readonly count: number;
  /** The arguments of each call, in order. */
  readonly calls: readonly unknown[][];
  restore(): void;
}

export function captureConsoleErrors(): CapturedConsoleErrors {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    get count() {
      return calls.length;
    },
    calls,
    restore() {
      console.error = original;
    },
  };
}
