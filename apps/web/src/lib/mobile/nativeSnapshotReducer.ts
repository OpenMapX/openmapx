/**
 * The page's read model of a native session.
 *
 * Under native authority the browser stops deciding anything about navigation
 * and starts rendering what it is told. That makes this reducer the whole
 * contract: everything the user sees comes through it, and anything it accepts
 * wrongly is drawn on the map as if it were true.
 *
 * So it is deliberately unforgiving. A delta applies only to the exact state it
 * was computed from — same session, same route or itinerary, one revision
 * forward. Anything else is refused, and refusing means asking for a full
 * snapshot rather than guessing at the gap. A missing update is a moment of
 * staleness; a wrongly-applied one is a puck on the wrong road.
 */

import type { NativeNavigationProjection } from "@openmapx/core";

export type NativeAuthority = "browser" | "native";

export interface SnapshotEnvelope {
  type: "full" | "progress";
  sessionId: string;
  revision: number;
  /** `routeFingerprint` for ground, `itineraryFingerprint` for transit. */
  fingerprint: string;
  kind: "ground" | "transit";
  data: Record<string, unknown>;
}

export interface NativeReadModel {
  sessionId: string;
  revision: number;
  fingerprint: string;
  kind: "ground" | "transit";
  /** The full snapshot, with every delta folded into it. */
  snapshot: Record<string, unknown>;
  /** Events the page has received but not yet acknowledged. */
  pendingEventIds: string[];
}

export type ApplyOutcome =
  | { ok: true; model: NativeReadModel; changed: boolean }
  | { ok: false; reason: "need-full-snapshot" | "stale" };

/** Fields a progress snapshot is permitted to move. */
const HOT_FIELDS = [
  "revision",
  "status",
  "progress",
  "weakGps",
  "offRoute",
  "coasting",
  "currentSpeedLimit",
  "connectivity",
  "reroute",
  "currentLegIndex",
  "currentWalkStepIndex",
  "phase",
  "confidence",
  "liveStatus",
] as const;

/**
 * Reads the identity out of a raw snapshot payload.
 *
 * Ground and transit name their fingerprint differently, which is fine on the
 * wire but would spread a conditional through every consumer. It is normalised
 * once, here.
 */
export function envelopeOf(snapshot: unknown): SnapshotEnvelope | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const raw = snapshot as Record<string, unknown>;

  const type = raw.type;
  if (type !== "full" && type !== "progress") return null;
  const kind = raw.kind === "transit" ? "transit" : raw.kind === "ground" ? "ground" : null;

  const sessionId = raw.sessionId;
  const revision = raw.revision;
  const fingerprint = raw.routeFingerprint ?? raw.itineraryFingerprint;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;

  // A progress snapshot does not carry `kind`; it inherits the model's.
  return {
    type,
    sessionId,
    revision,
    fingerprint,
    kind: kind ?? "ground",
    data: raw,
  };
}

/**
 * Folds one snapshot into the model.
 *
 * A full snapshot is authoritative by definition — it is what the session *is*,
 * and a reload legitimately produces one at any revision, including an older one
 * if the page had been running ahead on deltas it should not have had.
 */
export function applyNativeSnapshot(
  current: NativeReadModel | null,
  incoming: SnapshotEnvelope,
): ApplyOutcome {
  if (incoming.type === "full") {
    return {
      ok: true,
      changed: current?.revision !== incoming.revision || current?.sessionId !== incoming.sessionId,
      model: {
        sessionId: incoming.sessionId,
        revision: incoming.revision,
        fingerprint: incoming.fingerprint,
        kind: incoming.kind,
        snapshot: incoming.data,
        pendingEventIds: current?.sessionId === incoming.sessionId ? current.pendingEventIds : [],
      },
    };
  }

  if (!current) return { ok: false, reason: "need-full-snapshot" };
  if (incoming.sessionId !== current.sessionId) return { ok: false, reason: "need-full-snapshot" };
  if (incoming.fingerprint !== current.fingerprint) {
    // The route or itinerary changed underneath this delta, so its progress
    // describes a line the page does not have.
    return { ok: false, reason: "need-full-snapshot" };
  }
  if (incoming.revision <= current.revision) return { ok: false, reason: "stale" };
  if (incoming.revision !== current.revision + 1) {
    // A gap means something was missed. Interpolating would invent a state that
    // never existed.
    return { ok: false, reason: "need-full-snapshot" };
  }

  const merged: Record<string, unknown> = { ...current.snapshot };
  for (const field of HOT_FIELDS) {
    if (field in incoming.data) merged[field] = incoming.data[field];
  }

  return {
    ok: true,
    changed: true,
    model: { ...current, revision: incoming.revision, snapshot: merged },
  };
}

/**
 * Turns the merged read model into the shape the navigation store renders.
 *
 * The wire snapshot and the store's state are deliberately different vocabularies
 * — the shell speaks in session terms, the UI in route terms — and this is the
 * single place the two are reconciled. A delta declares the revision it was
 * computed from so the store can re-check the step it is being asked to take
 * against the one it actually rendered.
 */
export function projectionOf(
  model: NativeReadModel,
  type: SnapshotEnvelope["type"],
): NativeNavigationProjection {
  const raw = model.snapshot;
  const pick = <T>(key: string): T | undefined => (key in raw ? (raw[key] as T) : undefined);

  const projection: NativeNavigationProjection = {
    sessionId: model.sessionId,
    revision: model.revision,
    fingerprint: model.fingerprint,
    kind: model.kind,
    status: nativeStatusToNavStatus(raw.status),
    ...(type === "progress" ? { baseRevision: model.revision - 1 } : {}),
  };

  const assign = <K extends keyof NativeNavigationProjection>(
    key: K,
    value: NativeNavigationProjection[K] | undefined,
  ) => {
    if (value !== undefined) projection[key] = value;
  };

  assign("mode", pick<NativeNavigationProjection["mode"]>("mode"));
  assign("route", pick<NativeNavigationProjection["route"]>("route"));
  assign("routeProvider", pick<string>("routeProvider") ?? undefined);
  assign(
    "routeSelectionIntent",
    pick<NativeNavigationProjection["routeSelectionIntent"]>("routeSelectionIntent"),
  );
  assign("progress", pick<NativeNavigationProjection["progress"]>("progress"));
  assign("offRoute", pick<boolean>("offRoute"));
  assign("weakGps", pick<boolean>("weakGps"));
  assign("coasting", pick<boolean>("coasting"));
  assign("currentSpeedLimit", pick<number | null>("currentSpeedLimit"));
  assign("itinerary", pick<NativeNavigationProjection["itinerary"]>("itinerary"));
  assign("transitProgress", pick<NativeNavigationProjection["transitProgress"]>("transitProgress"));
  assign("connectivity", pick<NativeNavigationProjection["connectivity"]>("connectivity"));
  assign("permissionMode", permissionModeOf(raw.permissionMode));
  assign("alertAvailability", alertAvailabilityOf(raw.alightAlertAvailability));
  assign("confidence", confidenceOf(raw.confidence, raw.coasting));

  // The followed route plus the alternatives the shell is still offering. A
  // ground snapshot carries them separately; the UI reads one list.
  const route = projection.route;
  const alternatives = pick<unknown[]>("alternatives");
  if (route && alternatives) {
    projection.routes = [route, ...(alternatives as NonNullable<typeof route>[])];
  } else if (route) {
    projection.routes = [route];
  }

  return projection;
}

/** The shell reports session status; the UI reads navigation status. */
function nativeStatusToNavStatus(status: unknown): NativeNavigationProjection["status"] {
  if (status === "arrived") return "arrived";
  if (status === "stopped" || status === "expired" || status === "error") return "idle";
  return "navigating";
}

function permissionModeOf(value: unknown): NativeNavigationProjection["permissionMode"] {
  return value === "denied" || value === "foreground" || value === "background" ? value : undefined;
}

function alertAvailabilityOf(value: unknown): NativeNavigationProjection["alertAvailability"] {
  return value === "scheduled" || value === "unavailable" || value === "disabled"
    ? value
    : undefined;
}

/**
 * How much the session trusts its position.
 *
 * Transit reports it directly. Ground does not, but a coasting ground session is
 * exactly the same claim — dead reckoning between fixes — so it is derived rather
 * than left blank.
 */
function confidenceOf(
  reported: unknown,
  coasting: unknown,
): NativeNavigationProjection["confidence"] {
  if (reported === "live" || reported === "coasting" || reported === "stale") return reported;
  if (typeof coasting === "boolean") return coasting ? "coasting" : "live";
  return undefined;
}

/** Records an event the page has seen but not yet acknowledged. */
export function rememberEvent(model: NativeReadModel, eventId: string): NativeReadModel {
  if (model.pendingEventIds.includes(eventId)) return model;
  return { ...model, pendingEventIds: [...model.pendingEventIds, eventId] };
}

/** Forgets events once native has confirmed the acknowledgement. */
export function forgetEvents(model: NativeReadModel, eventIds: readonly string[]): NativeReadModel {
  const removing = new Set(eventIds);
  return {
    ...model,
    pendingEventIds: model.pendingEventIds.filter((id) => !removing.has(id)),
  };
}

/**
 * Whether the page may run its own navigation engine.
 *
 * The only affirmative answer is `browser`. Every native state — negotiating,
 * compatible, incompatible, errored — is a refusal, because an installed app
 * running its own engine alongside a native session would produce two answers to
 * "where am I", spoken over each other.
 */
export function browserEngineAllowed(
  authority: NativeAuthority | "negotiating" | "error",
): boolean {
  return authority === "browser";
}
