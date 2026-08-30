import type { AirQualityStandardId } from "../types";
import {
  categoryDefinitionSchema,
  type StandardAdapter,
  standardSourceManifestSchema,
} from "./adapter";

export interface StandardResolution {
  ok: true;
  adapter: StandardAdapter;
  requestedId: AirQualityStandardId;
  resolvedRevision: string;
  cacheTag: string;
}

export interface StandardResolutionFailure {
  ok: false;
  reason: "unknown_standard" | "historical_gap";
  requestedId: AirQualityStandardId | string;
}

const adapters = new Map<AirQualityStandardId, StandardAdapter[]>();

export function registerStandardAdapter(adapter: StandardAdapter): void {
  standardSourceManifestSchema.parse(adapter.sourceManifest);
  categoryDefinitionSchema.array().min(1).parse(adapter.categories);
  if (adapter.sourceManifest.standardId !== adapter.standardId) {
    throw new TypeError("Source manifest standardId does not match adapter");
  }
  if (adapter.sourceManifest.resolvedRevision !== adapter.revision) {
    throw new TypeError("Source manifest revision does not match adapter");
  }
  if (
    Date.parse(adapter.sourceManifest.effectiveFrom) !== Date.parse(adapter.effectiveFrom) ||
    (adapter.sourceManifest.effectiveUntil === null
      ? adapter.effectiveUntil !== null
      : adapter.effectiveUntil === null ||
        Date.parse(adapter.sourceManifest.effectiveUntil) !== Date.parse(adapter.effectiveUntil))
  ) {
    throw new TypeError("Source manifest effective interval does not match adapter");
  }
  const effectiveFrom = Date.parse(adapter.effectiveFrom);
  const effectiveUntil =
    adapter.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(adapter.effectiveUntil);
  if (!Number.isFinite(effectiveFrom) || effectiveUntil <= effectiveFrom) {
    throw new TypeError("Standard adapter effective interval must be non-empty");
  }
  const existing = adapters.get(adapter.standardId) ?? [];
  if (existing.some(({ revision }) => revision === adapter.revision)) {
    throw new TypeError(
      `Duplicate air-quality standard revision: ${adapter.standardId}/${adapter.revision}`,
    );
  }
  if (
    existing.some((candidate) => {
      const candidateFrom = Date.parse(candidate.effectiveFrom);
      const candidateUntil =
        candidate.effectiveUntil === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(candidate.effectiveUntil);
      return effectiveFrom < candidateUntil && candidateFrom < effectiveUntil;
    })
  ) {
    throw new TypeError(`Air-quality standard effective intervals overlap: ${adapter.standardId}`);
  }
  adapters.set(
    adapter.standardId,
    [...existing, adapter].sort(
      (left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom),
    ),
  );
}

export function clearStandardRegistryForTests(): void {
  adapters.clear();
}

export function listStandardAdapters(): StandardAdapter[] {
  return [...adapters.values()]
    .flat()
    .sort(
      (left, right) =>
        left.standardId.localeCompare(right.standardId) ||
        left.effectiveFrom.localeCompare(right.effectiveFrom),
    );
}

export function resolveStandard(
  requestedId: AirQualityStandardId | string,
  evidenceAt: string,
): StandardResolution | StandardResolutionFailure {
  const candidates = adapters.get(requestedId as AirQualityStandardId);
  if (!candidates) return { ok: false, reason: "unknown_standard", requestedId };
  const instant = Date.parse(evidenceAt);
  if (!Number.isFinite(instant)) return { ok: false, reason: "historical_gap", requestedId };
  const matches = candidates.filter((adapter) => {
    const from = Date.parse(adapter.effectiveFrom);
    const until =
      adapter.effectiveUntil === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(adapter.effectiveUntil);
    return instant >= from && instant < until;
  });
  const adapter = matches.at(-1);
  if (!adapter) return { ok: false, reason: "historical_gap", requestedId };
  return {
    ok: true,
    adapter,
    requestedId: adapter.standardId,
    resolvedRevision: adapter.revision,
    cacheTag: `${adapter.standardId}@${adapter.revision}`,
  };
}
