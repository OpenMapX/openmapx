"use client";

const reported = new Set<string>();
const reportedErrors = new Map<string, string>();

/**
 * Report layers the app intends to draw that are not on the map. Deduped per
 * group+id, so a permanently missing layer is one line rather than one per idle
 * frame, and a layer that recovers can report again if it goes missing later.
 *
 * Call this on every check, including with an empty list — that is what clears
 * the dedup set when a layer comes back. Calling it only when something is
 * missing would leave a recovered layer marked as already-reported, and its next
 * disappearance would be silent.
 */
export function reportMissingLayers(entries: Array<{ key: string; missing: string[] }>): void {
  const stillMissing = new Set<string>();
  for (const entry of entries) {
    for (const id of entry.missing) {
      const token = `${entry.key}|${id}`;
      stillMissing.add(token);
      if (reported.has(token)) continue;
      reported.add(token);
      console.error(
        `[map] "${id}" should be on the map and is not. A style change destroys every source and layer the app added; whatever owns this one did not put it back.`,
      );
    }
  }
  for (const token of reported) {
    if (!stillMissing.has(token)) reported.delete(token);
  }
}

/**
 * Report a layer group whose descriptor could not be applied — a layer naming a
 * source the group does not declare, a source dropped while a layer still reads
 * from it. Deduped by message: the apply runs on every render, so an unchanged
 * fault would otherwise log on every one.
 */
export function reportGroupError(key: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (reportedErrors.get(key) === message) return;
  reportedErrors.set(key, message);
  console.error(
    `[map] a layer group could not be applied, so it is drawing nothing: ${message}`,
    error,
  );
}

/** Forget a group's last error, so a fault that returns is reported again. */
export function clearGroupError(key: string): void {
  reportedErrors.delete(key);
}
