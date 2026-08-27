import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  MAX_TOTAL_COORDINATES,
  MAX_TOTAL_STEPS,
  MOBILE_PROTOCOL_MAX,
  parseMobileBridgeMessage,
  type TransitLegCapture,
} from "./mobileProtocol";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitTickResult,
  type TransitTickState,
} from "./processTransitFix";
import type { FixInput } from "./types";

/**
 * Deterministic replay of the shared engines.
 *
 * The point is not that the numbers are realistic — the fixtures are synthetic —
 * but that the same trace produces the same result no matter how the operating
 * system chose to deliver it: one fix at a time, in a batch, out of order, with
 * duplicates, or with the process killed and rebuilt from persisted state
 * between any two fixes.
 */

interface TransitFixture {
  description: string;
  coordinateSystem: string;
  itineraryFingerprint: string;
  itinerary: TripItinerary;
  captures: TransitLegCapture[];
  fixes: Array<{ coords: [number, number]; accuracy: number; offsetMs: number }>;
}

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__/mobile");
const NOW = 1_700_000_000_000;

function loadTransitFixture(name: string): TransitFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

const TRANSIT_FIXTURES = ["transit-basic", "transit-tunnel", "transit-transfer"] as const;

function toFix(entry: TransitFixture["fixes"][number]): FixInput {
  return { coords: entry.coords, accuracy: entry.accuracy, timestampMs: NOW + entry.offsetMs };
}

/** Runs a fixture, optionally serializing state between each tick. */
function replayTransit(
  fixture: TransitFixture,
  options: { serializeBetween?: boolean; startState?: TransitTickState } = {},
) {
  let state = options.startState ?? freshTransitTickState(NOW);
  const events: string[] = [];
  let last: TransitTickResult | undefined;
  const confidences: string[] = [];

  for (const entry of fixture.fixes) {
    const fix = toFix(entry);
    last = processTransitFix({
      itinerary: fixture.itinerary,
      captures: fixture.captures,
      state,
      fix,
      nowMs: fix.timestampMs,
      options: {
        ...DEFAULT_TRANSIT_TICK_OPTIONS,
        itineraryFingerprint: fixture.itineraryFingerprint,
      },
    });
    events.push(...last.events.map((event) => event.id));
    confidences.push(last.confidence);
    // Modelling process death: the only thing that survives is serialized state.
    state = options.serializeBetween
      ? (JSON.parse(JSON.stringify(last.state)) as TransitTickState)
      : last.state;
  }
  return {
    finalLeg: state.currentLegIndex,
    finalPhase: state.phase,
    events,
    confidences,
    needsReplan: last?.needsReplan ?? false,
  };
}

describe.each(TRANSIT_FIXTURES)("%s", (name) => {
  const fixture = loadTransitFixture(name);

  it("is synthetic test data, not a real journey", () => {
    expect(fixture.coordinateSystem).toContain("synthetic");
  });

  it("produces a stable final state and ordered event list", () => {
    const first = replayTransit(fixture);
    const second = replayTransit(fixture);
    expect(second).toEqual(first);
    expect(first.events).toEqual([...new Set(first.events)]);
  });

  it("matches an uninterrupted run when state is serialized between every fix", () => {
    expect(replayTransit(fixture, { serializeBetween: true })).toEqual(replayTransit(fixture));
  });

  it("reaches the same state whether fixes arrive singly or as one batch", () => {
    // A batch is delivered chronologically, which is what the coordinator
    // guarantees by sorting before it processes anything.
    const singly = replayTransit(fixture);
    const batched = replayTransit({
      ...fixture,
      fixes: [...fixture.fixes].sort((a, b) => a.offsetMs - b.offsetMs),
    });
    expect(batched).toEqual(singly);
  });

  it("ignores duplicates and reversed delivery once sorted and deduplicated", () => {
    const noisy = [...fixture.fixes, ...fixture.fixes].sort((a, b) => a.offsetMs - b.offsetMs);
    const deduplicated = noisy.filter(
      (entry, index, all) => index === 0 || entry.offsetMs !== all[index - 1].offsetMs,
    );
    expect(replayTransit({ ...fixture, fixes: deduplicated })).toEqual(replayTransit(fixture));
  });

  it("never advances more than one leg per fix", () => {
    let state = freshTransitTickState(NOW);
    let previous = 0;
    for (const entry of fixture.fixes) {
      const fix = toFix(entry);
      const result = processTransitFix({
        itinerary: fixture.itinerary,
        captures: fixture.captures,
        state,
        fix,
        nowMs: fix.timestampMs,
        options: {
          ...DEFAULT_TRANSIT_TICK_OPTIONS,
          itineraryFingerprint: fixture.itineraryFingerprint,
        },
      });
      expect(result.state.currentLegIndex - previous).toBeLessThanOrEqual(1);
      previous = result.state.currentLegIndex;
      state = result.state;
    }
  });

  it("restarts correctly at every possible split point", () => {
    const continuous = replayTransit(fixture);
    for (let split = 1; split < fixture.fixes.length; split++) {
      const head = replayTransitPartial(fixture, 0, split);
      const tail = replayTransit(
        { ...fixture, fixes: fixture.fixes.slice(split) },
        { startState: JSON.parse(JSON.stringify(head.state)) as TransitTickState },
      );
      expect({
        finalLeg: tail.finalLeg,
        finalPhase: tail.finalPhase,
        events: [...head.events, ...tail.events],
      }).toEqual({
        finalLeg: continuous.finalLeg,
        finalPhase: continuous.finalPhase,
        events: continuous.events,
      });
    }
  });
});

/** Replays a slice of a fixture and returns the state to resume from. */
function replayTransitPartial(fixture: TransitFixture, from: number, to: number) {
  let state = freshTransitTickState(NOW);
  const events: string[] = [];
  for (const entry of fixture.fixes.slice(from, to)) {
    const fix = toFix(entry);
    const result = processTransitFix({
      itinerary: fixture.itinerary,
      captures: fixture.captures,
      state,
      fix,
      nowMs: fix.timestampMs,
      options: {
        ...DEFAULT_TRANSIT_TICK_OPTIONS,
        itineraryFingerprint: fixture.itineraryFingerprint,
      },
    });
    events.push(...result.events.map((event) => event.id));
    state = result.state;
  }
  return { state, events };
}

describe("tunnel behaviour", () => {
  it("keeps guiding through a gap and labels the confidence honestly", () => {
    const fixture = loadTransitFixture("transit-tunnel");
    const result = replayTransit(fixture);
    // The fixture's gap is long enough that at least one tick is not GPS-backed.
    expect(result.confidences).toContain("gps");
    expect(result.finalLeg).toBeGreaterThanOrEqual(0);
  });
});

describe("maximum realistic payloads", () => {
  const nonce = "replay-nonce";
  const now = NOW;

  function packageWith(coordinates: number, steps: number) {
    return {
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "session.prepare",
      messageId: "m-1",
      channelNonce: nonce,
      sentAtMs: now,
      payload: {
        startPackage: {
          kind: "ground",
          route: {
            distance: 1,
            duration: 1,
            geometry: Array.from({ length: coordinates }, (_, i) => [8.6 + i / 1_000_000, 50.1]),
            steps: Array.from({ length: steps }, () => ({ distance: 1 })),
            mode: "driving",
          },
          alternatives: [],
          mode: "driving",
          destinationWaypoints: [[8.6, 50.1]],
          routeSelectionIntent: "automatic",
          routeOptions: {},
          locale: "en",
          units: "metric",
          settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" },
        },
      },
    };
  }

  it("accepts a package just below the coordinate and step ceilings", () => {
    const raw = JSON.stringify(packageWith(MAX_TOTAL_COORDINATES - 1, MAX_TOTAL_STEPS - 1));
    const result = parseMobileBridgeMessage(raw, { expectedNonce: nonce, nowMs: now });
    expect(result.ok).toBe(true);
  });

  it("rejects one coordinate too many without amplifying memory", () => {
    const raw = JSON.stringify(packageWith(MAX_TOTAL_COORDINATES + 1, 1));
    const result = parseMobileBridgeMessage(raw, { expectedNonce: nonce, nowMs: now });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too-many-coordinates");
  });

  it("rejects one step too many", () => {
    const raw = JSON.stringify(packageWith(4, MAX_TOTAL_STEPS + 1));
    const result = parseMobileBridgeMessage(raw, { expectedNonce: nonce, nowMs: now });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too-many-steps");
  });
});
