---
title: Ride integrations
description: "Implement a ride-hailing provider with explicit coverage, comparison policy, fare basis, quote expiry and booking handoffs."
sidebar_position: 10
---

# Ride integrations

A ride integration implements `RideProvider` for availability, products, fares
and booking handoffs. Register it with `ctx.registerRideProvider` and declare
`domains: ["ride-hailing"]`. Read the [integration system](./integration-system.md)
and [built-in authoring guide](./writing-an-integration.md) first. Installed
community artifacts cannot execute provider code in the API process.

## What a ride integration is, and what it is not

`RideProvider` returns availability, products, quotes and booking handoffs.
`RoutingProvider` returns geometry, legs and navigation maneuvers. In the `ride`
travel mode, the ordinary driving router supplies map geometry; the ride
orchestrator handles provider selection and fares separately.

The contract lives in
`packages/integration-framework/src/contracts/ride-provider.ts` and is exported
from `@openmapx/integration-framework`.

## The contract

```ts
export interface RideProvider {
  readonly id: string;
  readonly meta: RideProviderMeta;
  readonly capabilities: Record<RideCapability, boolean>;
  readonly permitsComparison: boolean;
  readonly coverage?: { countries?: string[]; bbox?: [number, number, number, number] };
  readonly attribution: Attribution[];
  readonly quoteTtlSeconds?: number;

  getAvailability(request: RideQuoteRequest): Promise<MobilityResult<RideAvailability>>;
  createHandoff(request: RideQuoteRequest): Promise<RideHandoff> | RideHandoff;

  getQuotes?(request: RideQuoteRequest): Promise<MobilityResult<RideQuote[]>>;
  book?(request: RideBookingRequest): Promise<RideBooking>;
  getBooking?(bookingId: string): Promise<RideBooking>;
  cancelBooking?(bookingId: string): Promise<RideBooking>;
}
```

`getAvailability` and `createHandoff` are required. Optional methods must agree with the
`capabilities` object. Call `assertRideProviderContract` before registering; it
throws if a provider
advertises a capability it does not implement. For example,
`quote: true` requires `getQuotes`. The capability names are `deepLink`, `quote`, `booking` and `tracking`.
`deepLink` is required; `booking` requires `book`, and `tracking` requires
`getBooking`. `cancelBooking` is optional and has no separate capability flag. The repo-wide conformance test at
`apps/api/src/services/__tests__/provider-contract-conformance.test.ts` runs that
assertion against every integration's real `setup()`.

## `coverageChecked`: say what you actually know

`RideAvailability.coverageChecked` records whether the provider verified service
at the requested coordinate. Return `false` when no check was possible; the
panel then labels availability as unchecked.

- `integrations/ride-deeplink` sets `false`. It is a URL builder with no network access;
  it cannot verify service availability at a coordinate.
- `integrations/ride-gofs` sets `true`. It has the feed's actual service-area polygons and
  operating calendars, and does point-in-polygon against them.

## `permitsComparison`: the provider's terms, not the operator's preference

`permitsComparison` records whether the provider permits comparison with
competitors. It is a readonly provider property and cannot be overridden by
operator configuration. Review and document the applicable provider conditions
before enabling it.

The operator setting `allowQuoteComparison` unlocks a ranked multi-provider list. Even
when it is on, the orchestrator drops any provider whose `permitsComparison` is `false`
before dispatching, and the panel keeps those providers as separate chips below the list.

The current GOFS adapter sets it to `true`. That implementation choice does not
establish the terms of a newly configured feed; review its actual conditions.

## Fare basis

`RideFare.basis` is either `quoted` or `estimated`.

- `quoted` means the provider returned this number for this trip.
- `estimated` means we computed it locally from a published tariff and the driving
  route's distance and duration.

The UI labels estimated fares. If neither amount is available, omit the fare
and return the available ETA or product information. Do not fabricate a zero price.

## Quote lifetime

Quotes are short-lived by contract. The orchestrator stamps `expiresAt` from the
provider's `quoteTtlSeconds` (default 60), overriding whatever the provider returned, so
no provider can leave a stale price on screen by claiming a distant expiry. Providers
should still set their own floor for the case where they are used outside the
orchestrator.

Quotes are never written to `ctx.cache`, never logged, and never persisted. The GOFS client caches static feed files separately: explicit nonpositive TTLs
disable shared caching; positive TTLs are floored to 60 seconds; a missing or
invalid TTL defaults to 3,600 seconds.

## Personal data

Quote and handoff requests can expose precise pickup and dropoff coordinates.
Describe the actual recipients and data sent in source/privacy disclosures,
and apply these handling rules:

- Never log coordinates. The orchestrator logs the provider id, the method and a reason
  string, nothing else.
- Never write a quote, a fare, a rider identity, a driver identity, vehicle details or a
  driver location to `ctx.cache` or the database.
- Quote responses carry `Cache-Control: no-store`.

## A worked example: `integrations/ride-gofs`

The GOFS adapter reads demand-responsive transport feeds. Use
`integrations/ride-gofs/catalog.ts`, `feed.ts` and `provider.ts` as the reference
for discovery, acquisition, mapping and handoff construction. Feed availability,
credentials and supplied fare data vary by operator.

**Discovery.** A feed publishes a discovery document listing its other files. Note two
traps: the document is often served at a bare base URL (`https://api.example.com/gofs/11`)
rather than a path ending in `gofs.json`, and its feed list lives inside a mandatory BCP-47
language container (`data.en.feeds`) even though the prose reference shows a flat
`data.feeds`. The parser accepts both.

**Static files, TTL-cached.** `system_information`, `service_brands`, `zones`,
`operating_rules`, `calendars`, `fares`, `booking_rules` and `vehicle_types` are fetched
and cached using the TTL rules above. A `ttl` of `0` means _always refresh_ and
must not be floored into a positive lifetime.

**Availability.** Point-in-polygon of the pickup (and dropoff, when known) against
`zones`, then `operating_rules` matched against `calendars` and the requested wall-clock
time in the feed's own timezone. The surviving rules' `service_brands` become the
products, and their `vehicle_type_id` list supplies seats and wheelchair accessibility.

**Quotes.** `realtime_booking` is preferred and yields `basis: "quoted"`. Where a feed does
not publish it, `wait_time` supplies the ETA and a local `fares.json` computation supplies
`basis: "estimated"`. Fare tiers honour their `interval`, which rounds up: the spec's own
example is "3.30 CAD per kilometer, charged every 250 meters", and ignoring the interval
undercharges every trip that does not land on a boundary.

**Handoff.** `booking_detail.web_uri`, falling back to `booking_rules.booking_url`, then
the system URL, then a phone number. GOFS specifies the deep-link query parameters, and
`pickup_time` among them is Unix epoch seconds rather than a wall-clock string.

**Feed shapes vary.** The parsers accept calendar dates as `YYYYMMDD`, pickup windows as `HH:MM:SS`, brand colours without a leading `#`,
and wait times scoped by zone pair rather than by brand. `packages/mobility-formats/gofs.ts`
normalises all of these, with the reasoning recorded in comments beside each helper.

## Adding a keyed provider

Declare the credential in `configSchema` with `x-openmapx-secret: true` and an
`x-openmapx-setup` guide, then read it back from `ctx.config["<sourceId>-<field>"]`: the
resolved configuration supplies it, as for per-source keys in `bike-sharing`. Saving
a credential in the admin panel reloads the integration, so a new key takes effect without
a restart. Choose an explicit missing-credential behavior. The current GOFS catalog keeps
credential-required feed metadata and its provider can report unavailable; do
not send an authenticated request with an absent key.

A keyed source must also be a declared `dataSources` entry with `purpose` and `dataSent`
strings in every locale, because the rider's pickup and destination are sent to it by
name. `pnpm check-legal-tables`, `pnpm check-data-flows` and `pnpm check-credential-keys`
all enforce this.

When a request carries a credential header, pin redirects to the feed's own host.
`safeFetchJson` follows redirects, and without `allowedRedirectHosts` a 302 would hand
your API key to whatever host the `Location` names.

`integrations/ride-gofs` is the worked example: named support for one keyed feed (the
Montreal taxi registry, with its `X-API-KEY` scheme recorded in a `KEYED_FEEDS` table)
plus three generic slots so an operator can key a feed we do not ship support for.

## Next adapter: TOMP

TOMP is a possible future adapter, not a shipped ride integration.
`packages/mobility-formats-tomp` contains OpenAPI validation and SDK-generation
tooling rather than a runtime client. Use the committed contract and its notice
when evaluating support; this page does not track the upstream's latest release.

The potential mapping is:

| TOMP stage           | Ride method                         |
| -------------------- | ----------------------------------- |
| Planning/offers      | `getQuotes`, with `basis: "quoted"` |
| Booking              | `book`                              |
| Execution/leg status | `getBooking`                        |
| Cancellation         | `cancelBooking`                     |

Before implementing, decide the authenticated operator model, booking lifecycle,
credential handling, comparison conditions and whether to generate a runtime
client. The fake provider in `ride-booking-contract.test.ts` exercises the
contract; it does not establish interoperability with a live operator.

## Verify a provider

Test capability conformance, checked versus unchecked coverage, comparison
filtering, quoted versus estimated fares, expiry replacement, absent credentials
and handoff encoding. GOFS fixtures should cover language containers, zero TTL,
calendar/timezone boundaries and fare-tier rounding. Use synthetic coordinates
and rider data; live feeds and booking relationships need separate validation.
