/**
 * The page's read model of a native session.
 *
 * Under native authority the browser stops deciding anything about navigation
 * and starts rendering what it is told. That makes this reducer the whole
 * contract: everything the user sees comes through it, and anything it accepts
 * wrongly is drawn on the map as if it were true.
 *
 * So it is deliberately unforgiving about identity. A delta applies only to the
 * session and route or itinerary it was computed for, and only if it is newer
 * than what the page has. Anything else is refused, and refusing means asking
 * for a full snapshot rather than guessing. A wrongly-applied update is a puck
 * on the wrong road.
 *
 * A delta is absolute, not a difference: it carries every value a progress
 * commit can change, read from the committed session. So a newer delta may
 * follow a gap. The shell throttles progress and drops the deltas in between,
 * and applying the newest one gives the same state as applying them all.
 */

import type {
  NativeNavigationProjection,
  NavProgress,
  Route,
  TransitProgress,
} from "@openmapx/core";
import {
  type GroundSnapshotWire,
  NATIVE_SNAPSHOT_HOT_FIELDS,
  type NativeSnapshotWire,
  type TransitLegCapture,
  type TransitSnapshotWire,
} from "@openmapx/core/navigation";

export type NativeAuthority = "browser" | "native";

interface SnapshotIdentity {
  type: "full" | "progress";
  sessionId: string;
  revision: number;
  /** `routeFingerprint` for ground, `itineraryFingerprint` for transit. */
  fingerprint: string;
}

/** One received snapshot, placed: which session, revision and route it describes. */
export type SnapshotEnvelope =
  | (SnapshotIdentity & { kind: "ground"; data: GroundSnapshotWire })
  | (SnapshotIdentity & { kind: "transit"; data: TransitSnapshotWire });

interface ReadModelIdentity {
  sessionId: string;
  revision: number;
  fingerprint: string;
}

/** What the page holds: the full snapshot, with every delta folded into it. */
export type NativeReadModel =
  | (ReadModelIdentity & { kind: "ground"; snapshot: GroundSnapshotWire })
  | (ReadModelIdentity & { kind: "transit"; snapshot: TransitSnapshotWire });

export type ApplyOutcome =
  | {
      ok: true;
      model: NativeReadModel;
      changed: boolean;
      /** For a delta, the revision of the model it was folded onto. */
      baseRevision?: number;
    }
  | { ok: false; reason: "need-full-snapshot" | "stale" };

/**
 * Places a snapshot the bridge has already checked against the shared wire
 * schema (`nativeSnapshot` in core). A ground snapshot names its route's
 * fingerprint and a transit one its itinerary's; that is what tells them apart,
 * including a progress snapshot, which does not repeat its kind. The empty
 * snapshot that answers a request when there is no session places nowhere.
 */
export function envelopeOf(snapshot: NativeSnapshotWire): SnapshotEnvelope | null {
  if (!("type" in snapshot)) return null;
  const identity = {
    type: snapshot.type,
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
  };
  // The schema guarantees one of the two fingerprints; their index signatures
  // keep TypeScript from narrowing on it, so the branch is asserted here.
  if (typeof snapshot.routeFingerprint === "string") {
    const data = snapshot as GroundSnapshotWire;
    return { ...identity, kind: "ground", fingerprint: data.routeFingerprint, data };
  }
  if (typeof snapshot.itineraryFingerprint === "string") {
    const data = snapshot as TransitSnapshotWire;
    return { ...identity, kind: "transit", fingerprint: data.itineraryFingerprint, data };
  }
  return null;
}

/**
 * Folds one snapshot into the model.
 *
 * A full snapshot establishes the baseline after a reload. Within an adopted
 * transit session, a delayed command response must not undo a newer publication.
 * Session revisions are monotonic even across itinerary replacements.
 */
export function applyNativeSnapshot(
  current: NativeReadModel | null,
  incoming: SnapshotEnvelope,
): ApplyOutcome {
  if (incoming.type === "full") {
    if (
      current?.kind === "transit" &&
      incoming.kind === "transit" &&
      current.sessionId === incoming.sessionId &&
      incoming.revision < current.revision
    )
      return { ok: false, reason: "stale" };
    return {
      ok: true,
      changed: current?.revision !== incoming.revision || current?.sessionId !== incoming.sessionId,
      model:
        incoming.kind === "ground"
          ? { ...identityOf(incoming), kind: "ground", snapshot: incoming.data }
          : { ...identityOf(incoming), kind: "transit", snapshot: incoming.data },
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

  const merged: Record<string, unknown> = { ...current.snapshot };
  for (const field of NATIVE_SNAPSHOT_HOT_FIELDS) {
    // A replacement can publish an empty tick before its next fix. Keep the
    // last authoritative position rather than resetting the walking banner.
    if (
      field === "transitProgress" &&
      (current.kind !== "transit" ||
        !incoming.data[field] ||
        typeof incoming.data[field] !== "object" ||
        Array.isArray(incoming.data[field]))
    )
      continue;
    if (field in incoming.data) merged[field] = incoming.data[field];
  }

  // Only the hot values of a delta for the same session and fingerprint were
  // folded in, so the merged record is still the kind of snapshot it was.
  const model = { ...current, revision: incoming.revision, snapshot: merged } as NativeReadModel;
  return { ok: true, changed: true, model, baseRevision: current.revision };
}

function identityOf(incoming: SnapshotEnvelope): ReadModelIdentity {
  return {
    sessionId: incoming.sessionId,
    revision: incoming.revision,
    fingerprint: incoming.fingerprint,
  };
}

/**
 * Turns the merged read model into the shape the navigation store renders.
 *
 * The wire snapshot and the store's state are deliberately different vocabularies
 * — the shell speaks in session terms, the UI in route terms — and this is the
 * single place the two are reconciled. A delta declares the revision of the
 * model it was folded onto (`baseRevision` from `applyNativeSnapshot`), so the
 * store can check that it rendered that same model.
 */
export function projectionOf(
  model: NativeReadModel,
  type: SnapshotEnvelope["type"],
  baseRevision?: number,
): NativeNavigationProjection {
  const { snapshot } = model;
  const projection: NativeNavigationProjection = {
    sessionId: model.sessionId,
    revision: model.revision,
    fingerprint: model.fingerprint,
    kind: model.kind,
    status: nativeStatusToNavStatus(snapshot.status),
    ...(type === "progress" && baseRevision !== undefined ? { baseRevision } : {}),
  };

  const assign = <K extends keyof NativeNavigationProjection>(
    key: K,
    value: NativeNavigationProjection[K] | undefined,
  ) => {
    if (value !== undefined) projection[key] = value;
  };

  assign("connectivity", connectivityOf(snapshot.connectivity));
  assign("permissionMode", permissionModeOf(snapshot.permissionMode));

  // Routes, progress and itineraries are the engine's own shapes. The wire
  // checks that each is an object; their bodies are typed as the engine's.
  if (model.kind === "ground") {
    const ground = model.snapshot;
    assign("mode", travelModeOf(ground.mode));
    assign("route", ground.route as Route | undefined);
    assign("routeProvider", ground.routeProvider);
    assign("routeSelectionIntent", routeSelectionIntentOf(ground.routeSelectionIntent));
    assign("progress", ground.progress as NavProgress | null | undefined);
    assign("offRoute", ground.offRoute);
    assign("weakGps", ground.weakGps);
    assign("coasting", ground.coasting);
    assign("currentSpeedLimit", ground.currentSpeedLimit);
    // A coasting ground session makes the same claim as transit's dead reckoning.
    if (ground.coasting !== undefined) assign("confidence", ground.coasting ? "coasting" : "live");

    // The followed route plus the alternatives the shell is still offering. A
    // ground snapshot carries them separately; the UI reads one list.
    const route = projection.route;
    if (route) projection.routes = [route, ...((ground.alternatives ?? []) as unknown as Route[])];
    return projection;
  }

  const transit = model.snapshot;
  assign("itinerary", transit.itinerary as NativeNavigationProjection["itinerary"]);
  assign(
    "transitReplanOptions",
    transit.transitReplanOptions as NativeNavigationProjection["transitReplanOptions"],
  );
  assign("transitCaptures", transit.captures as TransitLegCapture[] | undefined);
  assign("transitProgress", transit.transitProgress as TransitProgress | null | undefined);
  const refresh = transit.liveStatus?.refresh;
  if (transit.liveStatus)
    assign("liveDataUnavailable", refresh === "broken" || refresh === "stale");
  assign("alertAvailability", alertAvailabilityOf(transit.alightAlertAvailability));
  assign("confidence", transitConfidenceOf(transit.confidence));
  return projection;
}

/** The shell reports session status; the UI reads navigation status. */
function nativeStatusToNavStatus(status: unknown): NativeNavigationProjection["status"] {
  if (status === "arrived") return "arrived";
  if (status === "stopped" || status === "expired" || status === "error") return "idle";
  return "navigating";
}

function travelModeOf(value: string | undefined): NativeNavigationProjection["mode"] {
  return value === "driving" || value === "walking" || value === "cycling" || value === "motorcycle"
    ? value
    : undefined;
}

function routeSelectionIntentOf(
  value: string | undefined,
): NativeNavigationProjection["routeSelectionIntent"] {
  return value === "automatic" || value === "userSelected" ? value : undefined;
}

/** The session's own `unknown` is no reading at all, so it is not shown as one. */
function connectivityOf(value: string | undefined): NativeNavigationProjection["connectivity"] {
  return value === "online" || value === "offline" ? value : undefined;
}

/** The session's grant: background tracking, or tracking only while the app is open. */
function permissionModeOf(value: string | undefined): NativeNavigationProjection["permissionMode"] {
  if (value === "background") return "background";
  if (value === "foreground-only") return "foreground";
  return undefined;
}

function alertAvailabilityOf(
  value: string | undefined,
): NativeNavigationProjection["alertAvailability"] {
  return value === "scheduled" || value === "unavailable" || value === "disabled"
    ? value
    : undefined;
}

/**
 * How much a transit session trusts its position: a GPS fix, an estimate from
 * the timetable (the same claim as coasting), or nothing current.
 */
function transitConfidenceOf(value: string | undefined): NativeNavigationProjection["confidence"] {
  if (value === "gps") return "live";
  if (value === "schedule") return "coasting";
  if (value === "stale") return "stale";
  return undefined;
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
