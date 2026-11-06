import type { Itinerary, Leg } from "@motis-project/motis-client";
import { coherentTransitLegs, sameTransitPlace } from "@openmapx/mobility-core/transit-alternative";
import { expandedModes, isTransit } from "./plan-diversity.js";
export interface AlternativeContext {
  modes?: readonly string[];
  wheelchair?: boolean;
  requireBikeTransport?: boolean;
  maxTransfers?: number;
  transferBufferMinutes?: number;
  additionalTransferMinutes?: number;
  time?: string;
  arriveBy?: boolean;
}
const place = (p: Leg["from"]) => ({ name: p.name, stopId: p.stopId, lat: p.lat, lng: p.lon });
/** Validate the full upstream replacement against its surrounding runs and original hard requirements. */
export function alternativeReplacement(
  parent: Itinerary,
  index: number,
  chain: Leg[],
  context: AlternativeContext,
): { fromLegIndex: number; toLegIndex: number } | null {
  if (
    !chain.length ||
    chain.length > 6 ||
    !isTransit(parent.legs[index]) ||
    parent.legs[index].interlineWithPreviousLeg
  )
    return null;
  const runStarts = chain.filter((l) => isTransit(l) && !l.interlineWithPreviousLeg);
  if (runStarts.length !== 1 || chain.filter(isTransit).length === 0) return null;
  const firstTransit = chain.findIndex(isTransit),
    lastTransit = chain.findLastIndex(isTransit);
  if (chain.slice(firstTransit, lastTransit + 1).some((l) => !isTransit(l))) return null;
  let fromLegIndex = index,
    toLegIndex = index;
  while (fromLegIndex > 0 && !isTransit(parent.legs[fromLegIndex - 1])) fromLegIndex--;
  while (
    toLegIndex + 1 < parent.legs.length &&
    parent.legs[toLegIndex + 1].interlineWithPreviousLeg
  )
    toLegIndex++;
  while (toLegIndex + 1 < parent.legs.length && !isTransit(parent.legs[toLegIndex + 1]))
    toLegIndex++;
  const before = parent.legs[fromLegIndex - 1],
    after = parent.legs[toLegIndex + 1];
  if (
    !sameTransitPlace(place(parent.legs[fromLegIndex].from), place(chain[0].from)) ||
    !sameTransitPlace(place(parent.legs[toLegIndex].to), place(chain[chain.length - 1].to))
  )
    return null;
  const bufferMs = (context.transferBufferMinutes ?? 0) * 60_000;
  const extraMs = (context.additionalTransferMinutes ?? 0) * 60_000;
  const streetMs = (legs: Leg[]) =>
    legs.reduce((total, l) => total + Date.parse(l.endTime) - Date.parse(l.startTime), 0);
  const ingressBuffer = Math.max(bufferMs, streetMs(chain.slice(0, firstTransit)) + extraMs);
  const egressBuffer = Math.max(bufferMs, streetMs(chain.slice(lastTransit + 1)) + extraMs);
  if (
    before &&
    Date.parse(chain[firstTransit].startTime) - Date.parse(before.endTime) < ingressBuffer
  )
    return null;
  if (after && Date.parse(after.startTime) - Date.parse(chain[lastTransit].endTime) < egressBuffer)
    return null;
  const modes = expandedModes(context.modes);
  const streetModes = new Set(
    parent.legs
      .slice(fromLegIndex, toLegIndex + 1)
      .filter((l) => !isTransit(l))
      .map((l) => l.mode),
  );
  if ((before && after) || streetModes.size === 0) streetModes.add("WALK");
  if (
    chain.some((l) => l.cancelled || (isTransit(l) ? !modes.has(l.mode) : !streetModes.has(l.mode)))
  )
    return null;
  if (
    chain[firstTransit].tripId === parent.legs[index].tripId &&
    chain[firstTransit].startTime === parent.legs[index].startTime
  )
    return null;
  const combined = [
    ...parent.legs.slice(0, fromLegIndex),
    ...chain,
    ...parent.legs.slice(toLegIndex + 1),
  ];
  if (
    !coherentTransitLegs(
      combined.map((l) => ({
        from: place(l.from),
        to: place(l.to),
        startTime: l.startTime,
        endTime: l.endTime,
      })),
    )
  )
    return null;
  if (context.wheelchair && combined.some((l) => l.wheelchairAccessible === "NOT_ACCESSIBLE"))
    return null;
  if (
    context.requireBikeTransport &&
    combined.some((l) => isTransit(l) && l.bikesAllowed === false)
  )
    return null;
  const transfers = Math.max(
    0,
    combined.filter((l) => isTransit(l) && !l.interlineWithPreviousLeg).length - 1,
  );
  if (context.maxTransfers !== undefined && transfers > context.maxTransfers) return null;
  if (context.time) {
    const bound = Date.parse(context.time);
    if (
      !Number.isFinite(bound) ||
      (context.arriveBy
        ? Date.parse(combined[combined.length - 1].endTime) > bound
        : Date.parse(combined[0].startTime) < bound)
    )
      return null;
  }
  return { fromLegIndex, toLegIndex };
}
