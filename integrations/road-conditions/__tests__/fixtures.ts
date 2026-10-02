import type { RoadConditionEffect, RoadConditionEvent } from "@openmapx/core";

/** One effect binding every vehicle, fully read; `fields` replaces or adds keys. */
export const effect = (
  id: string,
  kind: RoadConditionEffect["kind"],
  fields: Record<string, unknown> = {},
): RoadConditionEffect =>
  ({
    id,
    kind,
    v: 1,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
    ...(kind === "closure" ? { scope: "road" } : {}),
    ...fields,
  }) as RoadConditionEffect;

/** A text in the publisher's one language. */
export const text = (value: string, lang = "en") => [{ lang, text: value }];

/** A live feed accident with no effects; `overrides` replaces any field. */
export const situation = (overrides: Partial<RoadConditionEvent> = {}): RoadConditionEvent => ({
  id: "oc:situation:nl-ndw:1",
  source: "nl-ndw",
  provider: "road-conditions-openconditions",
  kind: "incident",
  type: "accident",
  severity: { label: "major" },
  certainty: "observed",
  temporality: "live",
  planned: false,
  headline: text("Accident on A1"),
  geometry: { type: "Point", coordinates: [5, 52] },
  validity: { status: "active" },
  effects: [],
  origin: "feed",
  attribution: { provider: "NDW", license: "CC0-1.0" },
  fetchedAt: "2026-09-11T12:00:00Z",
  ...overrides,
});
