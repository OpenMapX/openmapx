"use client";

const reported = new Set<string>();

/**
 * Report layers the app intends to draw that are not on the map. Deduped per
 * group+id, so a permanently missing layer is one line rather than one per idle
 * frame, and a layer that recovers can report again if it goes missing later.
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
