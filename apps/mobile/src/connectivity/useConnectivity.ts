import { useEffect, useRef, useState } from "react";
import {
  type ConnectivityState,
  type DebouncedConnectivity,
  foldConnectivity,
  initialConnectivity,
} from "./ConnectivityDriver";
import { NetInfoConnectivityDriver } from "./NetInfoConnectivityDriver";

export interface ConnectivityReading extends DebouncedConnectivity {
  changedAtMs: number;
  /** True on the tick where a confirmed offline-to-online transition happened. */
  restored: boolean;
}

/**
 * Subscribes to connectivity and splits it into what to show and what to act on.
 *
 * The displayed state updates immediately, because a user in a tunnel should
 * see the explanation at once. The confirmed state waits, because retrying a
 * request on every handover would be worse than not retrying at all.
 */
export function useConnectivity(): ConnectivityReading {
  const [reading, setReading] = useState<ConnectivityReading>(() => ({
    ...initialConnectivity(Date.now()),
    restored: false,
  }));
  const stateRef = useRef(initialConnectivity(Date.now()));

  useEffect(() => {
    const driver = new NetInfoConnectivityDriver();
    const apply = (observed: ConnectivityState) => {
      const folded = foldConnectivity(stateRef.current, observed, Date.now());
      stateRef.current = folded;
      setReading({
        displayed: folded.displayed,
        confirmed: folded.confirmed,
        changedAtMs: folded.changedAtMs,
        restored: folded.confirmedTransition,
      });
    };
    const unsubscribe = driver.subscribe(apply);
    return unsubscribe;
  }, []);

  return reading;
}
