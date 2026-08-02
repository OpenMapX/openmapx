import { act } from "@testing-library/react";
import { expect } from "vitest";
import type { FakeMap } from "./fakeMap";

export interface StackSnapshot {
  /** Layer ids in draw order — bottom first. */
  order: string[];
  layers: Array<[string, string]>;
  sources: Array<[string, string]>;
}

/**
 * Everything the app has put on the map: which sources exist and what data is in
 * them, which layers exist with what paint/layout/filter, and the order they draw
 * in. Serialised so a deep-equal failure names the field that drifted.
 */
export function snapshotStack(fake: FakeMap): StackSnapshot {
  const { state } = fake;
  return {
    order: [...state.layers.keys()],
    layers: [...state.layers.entries()].map(([id, layer]) => [
      id,
      JSON.stringify({
        layer,
        paint: state.paint.get(id) ?? null,
        layout: state.layout.get(id) ?? null,
        filter: state.filters.get(id) ?? null,
      }),
    ]),
    sources: [...state.sources.entries()].map(([id, source]) => [
      id,
      JSON.stringify({ type: source.type, data: source.data ?? null }),
    ]),
  };
}

/**
 * A style change must lose nothing. `setStyle` destroys every source and layer
 * the app added, so the only way this passes is if the layer rebuilds all of it
 * *with its data* — recreating empty sources renders nothing, silently, which is
 * the failure this assertion exists to catch.
 */
export function expectStyleSwapIsLossless(fake: FakeMap): void {
  const before = snapshotStack(fake);
  expect(before.sources.length + before.layers.length).toBeGreaterThan(0);
  act(() => {
    fake.map.setStyle({} as never);
  });
  expect(snapshotStack(fake)).toEqual(before);
}
