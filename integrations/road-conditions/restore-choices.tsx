"use client";

import { useLayoutEffect } from "react";
import { restoreRoadConditionsChoices } from "./store";

/** Bring back the reader's road-conditions layers and filters before the first paint. */
export function useRestoredRoadConditionsChoices(): void {
  useLayoutEffect(restoreRoadConditionsChoices, []);
}
