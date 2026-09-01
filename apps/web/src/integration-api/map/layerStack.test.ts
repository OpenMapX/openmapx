import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BAND_COUNT,
  BAND_ORDER_BASE,
  TZ_FILL_ORDER,
} from "@integrations/overlay-sun-time/map-layer";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import {
  anchorMapLayers,
  type LayerRegistration,
  layerRank,
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
 * Resolve a scanned order argument to a number, or `undefined` if the scan
 * can't evaluate it. Two shapes are understood: an integer literal (`-16`,
 * `0`), and a bare identifier that names a module-level `const NAME = <int>;`
 * (optionally `export`ed, since a guard test may need to import the constant
 * too — e.g. `TZ_FILL_ORDER`) in the same file (e.g. `SUBSOLAR_ORDER`).
 * Anything else — including a computed expression like `BAND_ORDER_BASE +
 * band` — is deliberately left unresolved rather than guessed at: evaluating
 * arithmetic would make the scan a second implementation of the code it's
 * checking.
 */
function resolveOrder(raw: string, source: string): number | undefined {
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) return undefined;
  const constMatch = source.match(
    new RegExp(`^(?:export\\s+)?const\\s+${raw}\\s*=\\s*(-?\\d+)\\s*;`, "m"),
  );
  return constMatch ? Number(constMatch[1]) : undefined;
}

/**
 * Every layer in the app, read out of the source rather than out of the
 * registry: a layer registers itself when its component mounts, so no running
 * snapshot of the registry ever holds the whole stack — the one thing a
 * duplicate check has to see all of.
 *
 * `unresolved` lists the `addLayerInSlot`-shaped call sites whose order
 * argument `resolveOrder` couldn't evaluate, so a change to the scan doesn't
 * silently drop coverage — a future reader can see exactly what it doesn't
 * see.
 */
function declaredSlots(): {
  found: Array<{ id: string; slot: LayerRegistration["slot"]; order: number }>;
  unresolved: string[];
} {
  const repoRoot = repoRootFrom(process.cwd());
  // The order argument can be an integer literal (optionally negative) or an
  // arbitrary expression; capture whatever sits between the slot string and
  // the call's closing paren and let `resolveOrder` decide what it can read.
  const pattern = new RegExp(
    `"(${MAP_LAYER_SLOTS.join("|")})"\\s*,\\s*([^,()]+?)\\s*,?\\s*\\)`,
    "g",
  );
  const found: Array<{ id: string; slot: LayerRegistration["slot"]; order: number }> = [];
  const unresolved: string[] = [];

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
        const id = `${path.slice(repoRoot.length)}:${line}`;
        const order = resolveOrder(match[2], source);
        if (order === undefined) {
          unresolved.push(`${id} [${match[1]}] order expression ${JSON.stringify(match[2])}`);
          continue;
        }
        found.push({ id, slot: match[1] as LayerRegistration["slot"], order });
      }
    }
  };
  walk(join(repoRoot, "apps/web/src"));
  walk(join(repoRoot, "integrations"));
  return { found, unresolved };
}

describe("slot assignments", () => {
  it("gives every layer its own (slot, order)", () => {
    const { found: declarations, unresolved } = declaredSlots();
    // Guards the scan itself: a formatting change that stopped the pattern
    // matching would otherwise turn this into a test of nothing.
    expect(declarations.length).toBeGreaterThan(100);
    // Not an assertion — a computed order expression (e.g. overlay-sun-time's
    // `BAND_ORDER_BASE + band`) is expected to show up here on every run.
    // Surfacing it keeps the gap visible instead of it quietly meaning
    // nothing was ever checked.
    if (unresolved.length > 0) {
      console.info(`declaredSlots(): left ${unresolved.length} order expression(s) unresolved:
${unresolved.join("\n")}`);
    }

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

describe("sun-time terminator band order", () => {
  it("keeps the sun-time band block above raster-overlays but below every other area-overlays layer", () => {
    const { found } = declaredSlots();
    const areaOverlays = found.filter((d) => d.slot === "area-overlays");
    // overlay-sun-time also declares the time zone tint in this slot (see the
    // "sun-time time zone tint order" describe below), whose invariant is the
    // opposite of the band block's — it belongs on top, not underneath. Its
    // order is always positive (TZ_FILL_ORDER), the band block's is always
    // negative (BAND_ORDER_BASE + band), so filtering to negative orders here
    // keeps the two from being folded into one check.
    const sunTimeOrders = areaOverlays
      .filter((d) => d.id.includes("/overlay-sun-time/") && d.order < 0)
      .map((d) => d.order);
    const otherOrders = areaOverlays
      .filter((d) => !d.id.includes("/overlay-sun-time/"))
      .map((d) => d.order);
    // Each band's order (`BAND_ORDER_BASE + band`) is a computed expression
    // the scan can't resolve, so it never contributes to `sunTimeOrders` —
    // fall back to the same constants the block is reserved from. Both ends
    // matter: comparing only the lowest order would stay true even if
    // `BAND_ORDER_BASE` moved to 0, since the block's low end would still
    // sit below whatever a positive `otherOrders` happens to start at while
    // its high end quietly collided in the middle of that range.
    const lowestSunTimeOrder =
      sunTimeOrders.length > 0 ? Math.min(...sunTimeOrders) : BAND_ORDER_BASE;
    const highestSunTimeOrder =
      sunTimeOrders.length > 0 ? Math.max(...sunTimeOrders) : BAND_ORDER_BASE + BAND_COUNT - 1;

    for (const order of otherOrders) {
      expect(highestSunTimeOrder).toBeLessThan(order);
    }

    const maxRasterOverlayOrder = Math.max(
      ...found.filter((d) => d.slot === "raster-overlays").map((d) => d.order),
    );
    expect(layerRank("area-overlays", lowestSunTimeOrder)).toBeGreaterThan(
      layerRank("raster-overlays", maxRasterOverlayOrder),
    );
  });
});

describe("sun-time time zone tint order", () => {
  it("keeps the time zone fill above every other area-overlays layer, not just the terminator bands", () => {
    const { found } = declaredSlots();
    const otherOrders = found
      .filter((d) => d.slot === "area-overlays" && !d.id.includes("/overlay-sun-time/"))
      .map((d) => d.order);

    for (const order of otherOrders) {
      expect(TZ_FILL_ORDER).toBeGreaterThan(order);
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
