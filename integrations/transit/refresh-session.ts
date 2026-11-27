import { randomUUID } from "node:crypto";
import {
  collectOrderedProviders,
  type IntegrationContext,
  type TransitProvider,
  type TripPlanRequest,
} from "@openmapx/integration-framework";
import type { TransitTripResolveRequest, TripItinerary } from "@openmapx/mobility-core/transit";
import type { TransitOrchestrator } from "./orchestrator.js";
import { createRefreshReplay } from "./refresh-replay.js";
import { signRefreshHandle, verifyRefreshHandle } from "./refresh-token.js";
import { envelope } from "./route-helpers.js";
import {
  TripReferenceEpochError,
  TripReferenceUnavailableError,
  TripReferenceUnsupportedError,
  TripReferenceValidationError,
} from "./trip-reference.js";

const REFRESH_TTL_SECONDS = 15 * 60;

/** Server-side state behind a refresh token for an itinerary found by search. */
interface SearchRefreshState {
  kind?: "search";
  providerId: string;
  instance: string;
  datasetEpoch: string;
  requestFingerprint: string;
  itineraryId: string;
  request: TripPlanRequest;
}

/** Server-side state behind a refresh token for an imported exact trip. */
interface ReferenceRefreshState {
  kind: "reference";
  request: TransitTripResolveRequest;
}

/** Where a search itinerary came from, so a refresh can ask the same planner again. */
export interface SearchRefreshOrigin {
  providerId: string;
  instance: string;
  datasetEpoch: string;
  requestFingerprint: string;
  request: TripPlanRequest;
}

export interface RefreshOutcome {
  status: number;
  body: unknown;
}

/** MOTIS refresh is only safe for station-to-station or walk-ended itineraries. */
export function isRefreshEligible(itinerary: TripItinerary): boolean {
  if (!itinerary.id || itinerary.legs.length === 0) return false;
  if (itinerary.legs.some((leg) => leg.rental || ["cycling", "driving"].includes(leg.mode))) {
    return false;
  }
  const first = itinerary.legs[0];
  const last = itinerary.legs.at(-1);
  return Boolean(
    first &&
      last &&
      ((first.mode === "walking" && last.mode === "walking") ||
        (first.from.stopId && last.to.stopId)),
  );
}

/**
 * Opaque, one-time itinerary refresh. A token is a signed handle to state kept in
 * the integration cache; redeeming it replays a concurrent or repeated redemption
 * instead of asking the planner twice. Without a secret no token is issued.
 */
export function createRefreshSession(
  ctx: IntegrationContext,
  orchestrator: TransitOrchestrator,
  secret: string,
) {
  const replay = createRefreshReplay(ctx);

  async function store(state: SearchRefreshState | ReferenceRefreshState): Promise<string> {
    const id = randomUUID();
    // Taken before the write so the token never outlives the state it points to.
    const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;
    // Refresh-token session state, not cached upstream data.
    await ctx.cache.set(`transit-refresh:${id}`, state, REFRESH_TTL_SECONDS);
    return signRefreshHandle(id, secret, expiresAt);
  }

  /** A refresh token for an itinerary found by search, if it can be refreshed. */
  async function issueForSearch(
    itinerary: TripItinerary,
    origin: SearchRefreshOrigin,
  ): Promise<string | undefined> {
    if (!isRefreshEligible(itinerary) || !secret || !itinerary.id) return undefined;
    return store({ ...origin, itineraryId: itinerary.id });
  }

  /** A refresh token that keeps an imported exact trip bound to its reference. */
  async function issueForReference(
    itinerary: TripItinerary,
    request: TransitTripResolveRequest,
  ): Promise<string | undefined> {
    if (!isRefreshEligible(itinerary) || !secret) return undefined;
    return store({ kind: "reference", request });
  }

  /** Whether the loaded planner whose id is `providerId` declares itinerary refresh. */
  function canRefresh(providerId: string | undefined): boolean {
    return (
      providerId !== undefined &&
      collectOrderedProviders<TransitProvider>(ctx, "transit").some(
        ({ provider }) =>
          provider.id === providerId && provider.capabilities.planningFeatures?.refresh === true,
      )
    );
  }

  function sourceIds(providerId: string | undefined, tripIds: readonly string[] = []): string[] {
    const matching = new Set(
      collectOrderedProviders<TransitProvider>(ctx, "transit")
        .filter(({ provider: p }) =>
          providerId ? p.id === providerId : tripIds.some((id) => id.startsWith(p.prefix)),
        )
        .map((entry) => entry.integrationId),
    );
    const manifests = new Map(
      ctx.getIntegrationsByDomain("transit").map((integration) => [integration.id, integration]),
    );
    return [...matching].flatMap((id) =>
      (manifests.get(id)?.manifest.dataSources ?? []).map((source) => source.sourceId),
    );
  }

  async function refreshReference(state: ReferenceRefreshState) {
    try {
      // Keep imported exact trips bound to their reference; never search for a replacement.
      const ids = sourceIds(
        undefined,
        state.request.reference.legs.map((leg) => leg.tripId),
      );
      const exact = await orchestrator.resolveTrip(state.request);
      const itinerary = exact.data?.itineraries[0];
      if (!itinerary)
        return { status: 409, body: { error: "The exact trip can no longer be refreshed" } };
      itinerary.refreshToken = await issueForReference(itinerary, state.request);
      return {
        status: 200,
        sourceIds: ids,
        body: envelope({ itinerary, fallbackOccurred: false }, exact.attributions, exact.freshness),
      };
    } catch (error) {
      if (error instanceof TripReferenceUnavailableError)
        return {
          status: 503,
          body: { error: "Exact trip source unavailable", retryable: true },
        };
      if (
        error instanceof TripReferenceEpochError ||
        error instanceof TripReferenceUnsupportedError ||
        error instanceof TripReferenceValidationError
      )
        return { status: 409, body: { error: "The exact trip can no longer be refreshed" } };
      throw error;
    }
  }

  async function refreshSearch(state: SearchRefreshState) {
    let ids = sourceIds(state.providerId);
    const outcome = await orchestrator.refreshTrip(state.providerId, {
      itineraryId: state.itineraryId,
      datasetEpoch: state.datasetEpoch,
      modes: state.request.modes,
      wheelchairRequired: state.request.wheelchairRequired,
      requireBikeTransport: state.request.requireBikeTransport,
      detailedTransfers: true,
    });
    if (outcome.status === "unavailable")
      return {
        status: 503,
        body: { error: "Itinerary refresh temporarily unavailable", retryable: true },
      };
    const refreshed = outcome.result;
    let itinerary = refreshed.data;
    let fallbackOccurred = false;
    let resultAttributions = refreshed.attributions;
    let resultFreshness = refreshed.freshness;
    if (!itinerary) {
      fallbackOccurred = true;
      const fallback = await orchestrator.planTrip({
        ...state.request,
        regionalAlternatives: false,
        pageCursor: undefined,
      });
      itinerary = fallback.data?.itineraries[0] ?? null;
      resultAttributions = fallback.attributions;
      resultFreshness = fallback.freshness;
    }
    if (!itinerary)
      return {
        status: 409,
        body: { error: "Itinerary can no longer be refreshed or replanned" },
      };
    if (fallbackOccurred)
      ids = sourceIds(
        undefined,
        itinerary.legs.flatMap((leg) => (leg.tripId ? [leg.tripId] : [])),
      );
    if (canRefresh(itinerary.source)) {
      itinerary.refreshToken = await issueForSearch(itinerary, {
        providerId: state.providerId,
        instance: state.instance,
        datasetEpoch: itinerary.datasetEpoch ?? state.datasetEpoch,
        requestFingerprint: state.requestFingerprint,
        request: state.request,
      });
    }
    return {
      status: 200,
      sourceIds: ids,
      body: envelope({ itinerary, fallbackOccurred }, resultAttributions, resultFreshness),
    };
  }

  /** The state id a refresh token names, or why the token is refused. */
  function verify(token: unknown): { ok: true; id: string } | { ok: false; error: string } {
    if (typeof token !== "string") return { ok: false, error: "Required: token" };
    try {
      return { ok: true, id: verifyRefreshHandle(token, secret).id };
    } catch {
      return { ok: false, error: "Invalid or expired itinerary refresh token" };
    }
  }

  /** Refresh the itinerary behind a verified token, replaying a repeated redemption. */
  function refresh(id: string): Promise<RefreshOutcome> {
    return replay(id, async () => {
      const state = await ctx.cache.get<SearchRefreshState | ReferenceRefreshState>(
        `transit-refresh:${id}`,
      );
      if (!state) return { status: 409, body: { error: "Itinerary refresh state expired" } };
      return state.kind === "reference" ? refreshReference(state) : refreshSearch(state);
    });
  }

  return { issueForSearch, issueForReference, verify, refresh, canRefresh };
}

export type RefreshSession = ReturnType<typeof createRefreshSession>;
