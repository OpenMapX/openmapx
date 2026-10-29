/** One container as `docker compose ps --format json` describes it. */
export type ComposePsEntry = Readonly<Record<string, unknown>>;

export class ComposePsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposePsFormatError";
  }
}

function isEntry(value: unknown): value is ComposePsEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the output of `docker compose ps --format json`. Compose 2.21 and
 * later print one object per line, and nothing for an empty stack; earlier
 * Compose v2 prints a single array on one line. Each non-empty line holds one
 * of those. Anything else is refused rather than read as fewer containers.
 */
export function parseComposePsJson(stdout: string): ComposePsEntry[] {
  const entries: ComposePsEntry[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    const text = line.trim();
    if (!text) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ComposePsFormatError(`docker compose ps line ${index + 1} is not JSON`);
    }
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!isEntry(entry)) {
        throw new ComposePsFormatError(
          `docker compose ps line ${index + 1} holds something other than containers`,
        );
      }
      entries.push(entry);
    }
  }
  return entries;
}
