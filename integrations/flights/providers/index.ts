import type { FlightProvider } from "../types.js";
import { googleProvider } from "./google.js";
import { kayakProvider } from "./kayak.js";
import { kiwiProvider } from "./kiwi.js";
import { momondoProvider } from "./momondo.js";
import { skiplaggedProvider } from "./skiplagged.js";
import { skyscannerProvider } from "./skyscanner.js";

/**
 * Registry of deep-link flight providers. Order is the default UI order.
 * To add a new engine: implement a `FlightProvider` module and append it here.
 */
export const FLIGHT_PROVIDERS: readonly FlightProvider[] = [
  skyscannerProvider,
  googleProvider,
  kayakProvider,
  kiwiProvider,
  momondoProvider,
  skiplaggedProvider,
];

export function getFlightProvider(id: string): FlightProvider | undefined {
  return FLIGHT_PROVIDERS.find((p) => p.id === id);
}
