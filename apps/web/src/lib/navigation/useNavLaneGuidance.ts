import {
  type ApproachLaneGuidance,
  fetchJunctionLookups,
  findJunctionCandidates,
  findJunctionDecisionPoints,
  type JunctionDecisionPoint,
  type JunctionLookupPoint,
  type JunctionLookupResult,
  junctionLookupPoints,
  resolveApproachLaneGuidance,
  sameJunction,
  useNavigationStore,
} from "@openmapx/core";
import { useEffect } from "react";
import { useNavLaneGuidanceStore } from "./laneGuidanceStore";

let routeGeneration = 0;
interface LookupEntry {
  point: JunctionDecisionPoint;
  lookup: JunctionLookupPoint;
  candidate: boolean;
  status: "pending" | "sent" | "done";
  result?: JunctionLookupResult;
}
let lookupEntries: LookupEntry[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failedBatches = 0;
const MAX_LOOKUP_POINTS = 40;
const LOOKUP_LOOKAHEAD = 10;
const LOOKUP_RETRY_MS = 30_000;
const LOOKUP_RETRY_MAX_MS = 240_000;

/** Batched OSM enrichment for the green lane arrows; never acquires imagery. */
export function useNavLaneGuidance(): void {
  const route = useNavigationStore((s) => s.route);
  const currentStepIndex = useNavigationStore((s) => s.progress?.currentStepIndex);
  const online = useNavigationStore((s) => s.connectivity === "online");
  useEffect(() => {
    const store = useNavLaneGuidanceStore.getState();
    routeGeneration += 1;
    cancelLookupRetry();
    const previousEntries = lookupEntries;
    lookupEntries = [];
    if (!route) {
      store.reset();
      return;
    }
    const accepted = findJunctionDecisionPoints(route);
    const candidates = findJunctionCandidates(route);
    const points = [...accepted, ...candidates];
    const candidateSteps = new Set(candidates.map((point) => point.stepIndex));
    lookupEntries = junctionLookupPoints(route, points)
      .map(({ stepIndex, lookup }, i) => ({
        point: points[i],
        lookup,
        candidate: candidateSteps.has(stepIndex),
        status: "pending" as const,
      }))
      .sort((a, b) => a.point.stepIndex - b.point.stepIndex);
    const carried = new Map<number, ApproachLaneGuidance>();
    for (const entry of lookupEntries) {
      const previous = previousEntries.find(
        (old) => old.status === "done" && sameJunction(old.point, entry.point),
      );
      if (!previous?.result) continue;
      const wasAccepted = store.byStep.has(previous.point.stepIndex);
      if (!entry.candidate && !wasAccepted) continue;
      entry.status = "done";
      entry.result = previous.result;
      if (entry.candidate) {
        if (!wasAccepted) continue;
        accepted.push(entry.point);
      }
      // Reuse raw lookup data, never the previous route's selected lanes.
      const guidance = resolveApproachLaneGuidance(previous.result, entry.point);
      if (guidance) carried.set(entry.point.stepIndex, guidance);
    }
    store.setRoute(route, accepted, carried);
  }, [route]);
  useEffect(() => {
    if (route && online) requestLookups(routeGeneration, currentStepIndex ?? 0);
  }, [route, currentStepIndex, online]);
  useEffect(
    () => () => {
      routeGeneration += 1;
      cancelLookupRetry();
      lookupEntries = [];
      useNavLaneGuidanceStore.getState().reset();
    },
    [],
  );
}

function requestLookups(generation: number, currentStepIndex: number): void {
  const ahead = lookupEntries.filter((entry) => entry.point.stepIndex > currentStepIndex);
  if (!ahead.slice(0, LOOKUP_LOOKAHEAD).some((entry) => entry.status === "pending")) return;
  const batch = ahead.filter((entry) => entry.status === "pending").slice(0, MAX_LOOKUP_POINTS);
  if (batch.length === 0) return;
  for (const entry of batch) entry.status = "sent";
  void fetchLaneGuidance(generation, batch);
}

/**
 * Ask again for what a batch left unanswered, after a delay that grows with
 * each consecutive failure. Only one retry is ever scheduled; it does nothing
 * for a superseded route, offline (the reconnect asks instead).
 */
function scheduleLookupRetry(generation: number): void {
  failedBatches += 1;
  if (retryTimer !== null) return;
  const delay = Math.min(LOOKUP_RETRY_MS * 2 ** (failedBatches - 1), LOOKUP_RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (generation !== routeGeneration) return;
    const nav = useNavigationStore.getState();
    if (nav.connectivity !== "online") return;
    requestLookups(generation, nav.progress?.currentStepIndex ?? 0);
  }, delay);
}

function cancelLookupRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  failedBatches = 0;
}

async function fetchLaneGuidance(generation: number, batch: LookupEntry[]): Promise<void> {
  const results = await fetchJunctionLookups(batch.map((entry) => entry.lookup));
  if (generation !== routeGeneration) return;
  const answered = batch.flatMap((entry, i) => {
    const result = results?.[i];
    if (!result || result.unavailable) {
      entry.status = "pending";
      return [];
    }
    entry.status = "done";
    entry.result = result;
    return [{ entry, result }];
  });
  if (answered.length < batch.length) scheduleLookupRetry(generation);
  else failedBatches = 0;
  // A candidate becomes a junction only where OSM puts the route on a motorway
  // or trunk carriageway at the split; an on-ramp's town street never is.
  const confirmed = answered.flatMap(({ entry, result }) =>
    entry.candidate && result.onMotorway ? [entry.point] : [],
  );
  if (confirmed.length > 0) useNavLaneGuidanceStore.getState().addDecisionPoints(confirmed);
  for (const { entry, result } of answered) {
    const store = useNavLaneGuidanceStore.getState();
    const point = store.byStep.get(entry.point.stepIndex);
    if (!point) continue;
    const guidance = resolveApproachLaneGuidance(result, point);
    if (guidance) store.setGuidance(point.stepIndex, guidance);
  }
}
