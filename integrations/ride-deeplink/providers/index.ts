import type { DeepLinkProvider } from "../types.js";
import { boltProvider } from "./bolt.js";
import { freenowProvider } from "./freenow.js";
import { lyftProvider } from "./lyft.js";
import { uberProvider } from "./uber.js";
import { yangoProvider } from "./yango.js";

/**
 * Registry of credential-free handoff providers. Order is the default UI
 * order. To add an app: implement a `DeepLinkProvider` module, append it here,
 * and add a matching `dataSources` entry to the manifest plus `purpose` and
 * `dataSent` strings in every locale.
 */
export const DEEPLINK_PROVIDERS: readonly DeepLinkProvider[] = [
  uberProvider,
  lyftProvider,
  boltProvider,
  freenowProvider,
  yangoProvider,
];

export function getDeepLinkProvider(id: string): DeepLinkProvider | undefined {
  return DEEPLINK_PROVIDERS.find((p) => p.id === id);
}
