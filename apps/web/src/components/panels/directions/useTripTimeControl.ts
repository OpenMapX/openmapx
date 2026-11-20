import { useDirectionsStore } from "@openmapx/core";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TimeMode } from "./TimeModePicker";

/**
 * The depart/arrive choice of the active trip. Transit and driving keep
 * separate times in the store; this adapts the one shared picker to whichever
 * flow is active.
 */
export function useTripTimeControl(isTransitMode: boolean) {
  const {
    transitTimeMode,
    transitDepartureTime,
    transitArrivalTime,
    timeMode,
    tripTime,
    setTransitTimeMode,
    setTransitDepartureTime,
    setTransitArrivalTime,
    setTimeMode,
    setTripTime,
  } = useDirectionsStore(
    useShallow((s) => ({
      transitTimeMode: s.transitTimeMode,
      transitDepartureTime: s.transitDepartureTime,
      transitArrivalTime: s.transitArrivalTime,
      timeMode: s.timeMode,
      tripTime: s.tripTime,
      setTransitTimeMode: s.setTransitTimeMode,
      setTransitDepartureTime: s.setTransitDepartureTime,
      setTransitArrivalTime: s.setTransitArrivalTime,
      setTimeMode: s.setTimeMode,
      setTripTime: s.setTripTime,
    })),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const mode: TimeMode = isTransitMode ? transitTimeMode : timeMode;
  const transitValue =
    mode === "depart" ? transitDepartureTime : mode === "arrive" ? transitArrivalTime : null;
  const value: Date | null = isTransitMode
    ? transitValue instanceof Date
      ? transitValue
      : null
    : tripTime;

  const changeMode = (next: TimeMode) => {
    if (!isTransitMode) {
      setTimeMode(next);
      if (next !== "now" && !tripTime) setTripTime(new Date());
      return;
    }
    setTransitTimeMode(next);
    if (next === "now") {
      setTransitDepartureTime("now");
      setTransitArrivalTime(null);
    } else if (next === "depart" && !(transitDepartureTime instanceof Date)) {
      setTransitDepartureTime(new Date());
    } else if (next === "arrive" && !transitArrivalTime) {
      setTransitArrivalTime(new Date());
    }
  };

  const changeValue = (next: Date) => {
    if (!isTransitMode) setTripTime(next);
    else if (transitTimeMode === "depart") setTransitDepartureTime(next);
    else setTransitArrivalTime(next);
  };

  return {
    mode,
    value,
    pickerOpen,
    togglePicker: () => setPickerOpen((open) => !open),
    changeMode,
    changeValue,
  };
}
