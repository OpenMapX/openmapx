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
