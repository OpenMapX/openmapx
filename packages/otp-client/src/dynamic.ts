import { operationBindings as digitransitBindings } from "./generated/digitransit/bindings";
import { getSdk as digitransitSdk } from "./generated/digitransit/sdk";
import { operationBindings as peatusBindings } from "./generated/peatus/bindings";
import { getSdk as peatusSdk } from "./generated/peatus/sdk";
import { operationBindings as stadtnaviBindings } from "./generated/stadtnavi/bindings";
import { getSdk as stadtnaviSdk } from "./generated/stadtnavi/sdk";
import { operationBindings as torinoBindings } from "./generated/torino/bindings";
import { getSdk as torinoSdk } from "./generated/torino/sdk";
import { operationBindings as trufiBindings } from "./generated/trufi/bindings";
import { getSdk as trufiSdk } from "./generated/trufi/sdk";
import { createRequester, type OtpTransportOptions } from "./transport";

export type GtfsFamily = "stadtnavi" | "peatus" | "torino" | "digitransit";
export function createDynamicGtfsClient(family: GtfsFamily, options: OtpTransportOptions) {
  switch (family) {
    case "stadtnavi": {
      const requester = createRequester(options, stadtnaviBindings);
      return {
        ...stadtnaviSdk<AbortSignal | undefined>(requester.request),
        assertAvailable: requester.assertAvailable,
      };
    }
    case "peatus": {
      const requester = createRequester(options, peatusBindings);
      return {
        ...peatusSdk<AbortSignal | undefined>(requester.request),
        assertAvailable: requester.assertAvailable,
      };
    }
    case "torino": {
      const requester = createRequester(options, torinoBindings);
      return {
        ...torinoSdk<AbortSignal | undefined>(requester.request),
        assertAvailable: requester.assertAvailable,
      };
    }
    case "digitransit": {
      const requester = createRequester(options, digitransitBindings);
      return {
        ...digitransitSdk<AbortSignal | undefined>(requester.request),
        assertAvailable: requester.assertAvailable,
      };
    }
  }
}
export function createDynamicTransmodelClient(options: OtpTransportOptions) {
  const requester = createRequester(options, trufiBindings);
  return {
    ...trufiSdk<AbortSignal | undefined>(requester.request),
    assertAvailable: requester.assertAvailable,
  };
}
export type {
  DynamicDeparturesQuery as DigitransitDepartures,
  DynamicNearbyQuery as DigitransitNearby,
  DynamicSearchQuery as DigitransitSearch,
} from "./generated/digitransit/sdk";
export type {
  DynamicDeparturesQuery as PeatusDepartures,
  DynamicNearbyQuery as PeatusNearby,
  DynamicSearchQuery as PeatusSearch,
} from "./generated/peatus/sdk";
export type {
  DynamicDeparturesQuery as StadtnaviDepartures,
  DynamicNearbyQuery as StadtnaviNearby,
  DynamicSearchQuery as StadtnaviSearch,
} from "./generated/stadtnavi/sdk";
export type {
  DynamicDeparturesQuery as TorinoDepartures,
  DynamicNearbyQuery as TorinoNearby,
  DynamicSearchQuery as TorinoSearch,
} from "./generated/torino/sdk";
export type {
  DynamicDeparturesQuery as TrufiDepartures,
  DynamicNearbyQuery as TrufiNearby,
  DynamicSearchQuery as TrufiSearch,
} from "./generated/trufi/sdk";
