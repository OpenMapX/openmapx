import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import type { ConnectivityDriver, ConnectivityState } from "./ConnectivityDriver";

/**
 * NetInfo behind the driver interface.
 *
 * `isInternetReachable` is deliberately preferred over `isConnected`: a device
 * attached to a captive portal reports a connection while every request fails.
 * When reachability is still being determined the answer is `unknown` rather
 * than a guess, because "we do not know yet" and "there is no network" call for
 * different behaviour.
 */
function toState(state: NetInfoState): ConnectivityState {
  if (state.isInternetReachable === null || state.isInternetReachable === undefined) {
    return state.isConnected ? "unknown" : "offline";
  }
  return state.isInternetReachable ? "online" : "offline";
}

export class NetInfoConnectivityDriver implements ConnectivityDriver {
  private state: ConnectivityState = "unknown";

  subscribe(listener: (state: ConnectivityState) => void): () => void {
    return NetInfo.addEventListener((next) => {
      this.state = toState(next);
      listener(this.state);
    });
  }

  current(): ConnectivityState {
    return this.state;
  }
}

/** Exposed for the driver's own tests; the mapping is the only logic here. */
export const netInfoStateToConnectivity = toState;
