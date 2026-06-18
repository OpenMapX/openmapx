import type { DeliveryProvider } from "../types.js";
import { deliverooProvider } from "./deliveroo.js";
import { doordashProvider } from "./doordash.js";
import { foodpandaProvider } from "./foodpanda.js";
import { glovoProvider } from "./glovo.js";
import { grubhubProvider } from "./grubhub.js";
import { ifoodProvider } from "./ifood.js";
import { justeatProvider } from "./justeat.js";
import { lieferandoProvider } from "./lieferando.js";
import { pedidosyaProvider } from "./pedidosya.js";
import { rappiProvider } from "./rappi.js";
import { swiggyProvider } from "./swiggy.js";
import { talabatProvider } from "./talabat.js";
import { uberEatsProvider } from "./ubereats.js";
import { woltProvider } from "./wolt.js";
import { zomatoProvider } from "./zomato.js";

/**
 * Registry of food-delivery deep-link providers. Each builder produces the most
 * location-scoped URL the platform supports so results land on the right city.
 * Order is the default UI order. To add a platform: implement a `DeliveryProvider`
 * module and append it.
 */
export const DELIVERY_PROVIDERS: readonly DeliveryProvider[] = [
  uberEatsProvider,
  woltProvider,
  lieferandoProvider,
  doordashProvider,
  deliverooProvider,
  justeatProvider,
  glovoProvider,
  foodpandaProvider,
  grubhubProvider,
  ifoodProvider,
  rappiProvider,
  pedidosyaProvider,
  swiggyProvider,
  zomatoProvider,
  talabatProvider,
];

export function getDeliveryProvider(id: string): DeliveryProvider | undefined {
  return DELIVERY_PROVIDERS.find((p) => p.id === id);
}

/** Whether a provider serves the given country (or is global). */
export function providerServes(provider: DeliveryProvider, countryCode?: string): boolean {
  if (provider.regions === "*") return true;
  if (!countryCode) return true; // no country known ⇒ don't pre-filter
  return provider.regions.includes(countryCode.toLowerCase());
}
