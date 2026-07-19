"use client";

import { useStopTransfers } from "@openmapx/core";
import type { StopTransfer, TripLeg } from "@openmapx/mobility-core/transit";
import { changedFromPlatform } from "@/lib/navigation/platformChange";

export interface TransferInfo {
  /** The vehicle's destination sign for the ride being boarded, when informative. */
  nextHeadsign?: string;
  /** Platform to board the next ride on. */
  boardPlatform?: string;
  /** Whether that platform changed from the scheduled track. */
  platformChanged: boolean;
  /** Floor change across the change (e.g. down to the U-Bahn), when both known. */
  levelChange: { from: number; to: number } | null;
  /** Step-free transfer option to the next stop (MOTIS transfers), if any. */
  stepFree?: StopTransfer;
  /** Walking time to the change, in whole minutes (0 when negligible). */
  walkMinutes: number;
}

/**
 * The facts about an interchange from `fromLeg` onto `nextLeg`, shared by the
 * nav transfer card and the planning transfer summary so both present the same
 * change (platform + change flag, level change, step-free option, walk time)
 * from one place. Fetches the MOTIS step-free transfer for the alight stop.
 */
export function useTransferInfo(
  fromLeg: TripLeg,
  nextLeg: TripLeg,
  walkSeconds: number,
): TransferInfo {
  const { data: transfers } = useStopTransfers(fromLeg.to.stopId ?? null);
  const stepFree = transfers?.find(
    (tr) => tr.toStopId === nextLeg.from.stopId && tr.wheelchairMinutes != null,
  );
  const nextHeadsign =
    nextLeg.headsign && nextLeg.headsign !== nextLeg.to.name ? nextLeg.headsign : undefined;
  const levelChange =
    fromLeg.to.level != null &&
    nextLeg.from.level != null &&
    fromLeg.to.level !== nextLeg.from.level
      ? { from: fromLeg.to.level, to: nextLeg.from.level }
      : null;

  return {
    nextHeadsign,
    boardPlatform: nextLeg.from.platformCode,
    platformChanged: !!changedFromPlatform(nextLeg.from),
    levelChange,
    stepFree,
    walkMinutes: walkSeconds > 0 ? Math.max(1, Math.round(walkSeconds / 60)) : 0,
  };
}
