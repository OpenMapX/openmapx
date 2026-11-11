import { useEffect, useState } from "react";
import type { ConnectivityState } from "./ConnectivityDriver";
import { NetInfoConnectivityDriver } from "./NetInfoConnectivityDriver";

export interface ConnectivityReading {
  /** The state to show, updated as soon as the platform reports it. */
  displayed: ConnectivityState;
}

/**
 * What the shell shows about connectivity: a user in a tunnel should see the
 * explanation at once. Navigation acts on a confirmed state instead, which its
 * composition derives through `ConfirmedConnectivity`.
 */
export function useConnectivity(): ConnectivityReading {
  const [displayed, setDisplayed] = useState<ConnectivityState>("unknown");

  useEffect(() => {
    const driver = new NetInfoConnectivityDriver();
    return driver.subscribe(setDisplayed);
  }, []);

  return { displayed };
}
