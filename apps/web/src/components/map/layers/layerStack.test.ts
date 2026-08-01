import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import {
  anchorMapLayers,
  type LayerRegistration,
  layerRegistrations,
  MAP_LAYER_SLOTS,
  planAnchorMoves,
  registerLayerSlot,
  resolveBeforeId,
  type StackLayer,
  unregisterLayerSlot,
} from "./layerStack";

const style = (...ids: Array<[string, string]>): StackLayer[] =>
  ids.map(([id, type]) => ({ id, type }));

const reg = (
  ...entries: Array<[string, LayerRegistration["slot"], number?]>
): LayerRegistration[] => entries.map(([id, slot, order]) => ({ id, slot, order: order ?? 0 }));

describe("resolveBeforeId", () => {
  it("returns the lowest registered layer ranked above the new one", () => {
    const layers = style(
      ["bg", "background"],
      ["omx-traffic-flow-color", "line"],
      ["omx-road-conditions-line", "line"],
      ["place-labels", "symbol"],
    );
    const registrations = reg(
      ["omx-traffic-flow-color", "traffic-flow", 1],
      ["omx-road-conditions-line", "conditions-lines"],
    );
    expect(resolveBeforeId(layers, registrations, "route-active", 1)).toBe(
      "omx-road-conditions-line",
    );
  });

  it("falls back to the first symbol layer for slots below basemap-symbols", () => {
    const layers = style(["bg", "background"], ["roads", "line"], ["place-labels", "symbol"]);
    expect(resolveBeforeId(layers, [], "route-active", 0)).toBe("place-labels");
  });

  it("returns undefined (top of stack) for slots above basemap-symbols", () => {
    const layers = style(["bg", "background"], ["place-labels", "symbol"]);
    expect(resolveBeforeId(layers, [], "nav-top", 0)).toBeUndefined();
  });

  it("orders within a slot by `order`", () => {
    const layers = style(["route-active-casing", "line"], ["place-labels", "symbol"]);
    const registrations = reg(["route-active-casing", "route-active", 0]);
    expect(resolveBeforeId(layers, registrations, "route-active", 1)).toBe("place-labels");
    expect(resolveBeforeId(layers, registrations, "route-alt", 0)).toBe("route-active-casing");
  });
});

describe("planAnchorMoves", () => {
  it("returns no moves when the registered layers are already in canonical order", () => {
    const layers = style(
      ["omx-traffic-flow-color", "line"],
      ["route-active-line", "line"],
      ["place-labels", "symbol"],
      ["nav-traffic-signals", "symbol"],
    );
    const registrations = reg(
      ["omx-traffic-flow-color", "traffic-flow", 1],
      ["route-active-line", "route-active", 1],
      ["nav-traffic-signals", "nav-top"],
    );
    expect(planAnchorMoves(layers, registrations)).toEqual([]);
  });

  it("reorders a route layer that was appended above the incident lines", () => {
    const layers = style(
      ["omx-road-conditions-line", "line"],
      ["place-labels", "symbol"],
      ["route-active-line", "line"],
    );
    const registrations = reg(
      ["omx-road-conditions-line", "conditions-lines"],
      ["route-active-line", "route-active", 1],
    );
    expect(planAnchorMoves(layers, registrations)).toEqual([
      { id: "omx-road-conditions-line", beforeId: "place-labels" },
      { id: "route-active-line", beforeId: "omx-road-conditions-line" },
    ]);
  });

  it("ignores registered layers that are not in the style", () => {
    const layers = style(["place-labels", "symbol"], ["route-active-line", "line"]);
    const registrations = reg(
      ["route-active-line", "route-active", 1],
      ["route-traffic", "route-congestion"],
    );
    expect(planAnchorMoves(layers, registrations).map((m) => m.id)).toEqual(["route-active-line"]);
  });

  it("is idempotent — applying the plan yields an empty second plan", () => {
    const layers = style(
      ["place-labels", "symbol"],
      ["route-active-line", "line"],
      ["omx-traffic-flow-color", "line"],
    );
    const registrations = reg(
      ["route-active-line", "route-active", 1],
      ["omx-traffic-flow-color", "traffic-flow", 1],
    );
    const moves = planAnchorMoves(layers, registrations);
    const applied = [...layers];
    for (const move of moves) {
      const index = applied.findIndex((l) => l.id === move.id);
      const [layer] = applied.splice(index, 1);
      const target = move.beforeId ? applied.findIndex((l) => l.id === move.beforeId) : -1;
      if (target === -1) applied.push(layer);
      else applied.splice(target, 0, layer);
    }
    expect(planAnchorMoves(applied, registrations)).toEqual([]);
  });
});

/** Walk up from the working directory to the workspace root the scan needs. */
function repoRootFrom(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) throw new Error(`no workspace root above ${start}`);
  }
}

/**
 * Every layer in the app, read out of the source rather than out of the
 * registry: a layer registers itself when its component mounts, so no running
 * snapshot of the registry ever holds the whole stack — the one thing a
 * duplicate check has to see all of.
 */
function declaredSlots(): Array<{ id: string; slot: LayerRegistration["slot"]; order: number }> {
  const repoRoot = repoRootFrom(process.cwd());
  const pattern = new RegExp(`"(${MAP_LAYER_SLOTS.join("|")})"\\s*,\\s*(\\d+)\\s*,?\\s*\\)`, "g");
  const found: Array<{ id: string; slot: LayerRegistration["slot"]; order: number }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (entry.name === "layerStack.ts") continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        found.push({
          id: `${path.slice(repoRoot.length)}:${line}`,
          slot: match[1] as LayerRegistration["slot"],
          order: Number(match[2]),
        });
      }
    }
  };
  walk(join(repoRoot, "apps/web/src"));
  walk(join(repoRoot, "integrations"));
  return found;
}

describe("slot assignments", () => {
  it("gives every layer its own (slot, order)", () => {
    const declarations = declaredSlots();
    // Guards the scan itself: a formatting change that stopped the pattern
    // matching would otherwise turn this into a test of nothing.
    expect(declarations.length).toBeGreaterThan(100);

    try {
      for (const { id, slot, order } of declarations) registerLayerSlot(id, slot, order);
      const byRank = new Map<string, string[]>();
      for (const registration of layerRegistrations()) {
        const rank = `${registration.slot} ${registration.order}`;
        byRank.set(rank, [...(byRank.get(rank) ?? []), registration.id]);
      }
      // A tie is resolved by registration order, which is mount order — the
      // race the slot registry exists to remove.
      const shared = [...byRank].filter(([, ids]) => ids.length > 1);
      expect(shared).toEqual([]);
    } finally {
      for (const { id } of declarations) unregisterLayerSlot(id);
    }
  });
});

describe("anchorMapLayers", () => {
  afterEach(() => {
    unregisterLayerSlot("omx-road-conditions-line");
    unregisterLayerSlot("route-active-line");
  });

  it("pulls an appended route layer back below the incident lines", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "omx-road-conditions-line", type: "line" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);
    map.addLayer({ id: "route-active-line", type: "line" } as never);
    registerLayerSlot("omx-road-conditions-line", "conditions-lines", 0);
    registerLayerSlot("route-active-line", "route-active", 1);

    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual([
      "route-active-line",
      "omx-road-conditions-line",
      "place-labels",
    ]);
  });
});
