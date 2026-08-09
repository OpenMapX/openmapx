---
title: Ride integrations
description: Writing a ride-hailing provider — the RideProvider contract, coverage and comparison rules, fare basis, quote lifetime, and a worked GOFS example.
sidebar_position: 10
---

# Ride integrations

A **ride integration** contributes a provider to OpenMapX's ride-hailing chain: an
on-demand transport feed, a taxi registry, or a commercial ride-hailing partner. This
page is the contract-level guide to writing one. It assumes you have read the
[integration system](./integration-system.md) page first.

## What a ride integration is, and what it is not

A ride integration contributes a `RideProvider`. It never contributes a
`RoutingProvider`.

That distinction is the whole reason the domain exists. `RoutingProvider.getRoute()`
returns geometry, legs and turn-by-turn maneuvers. A ride-hailing service returns none of
those — it returns a list of bookable products, a pickup wait time, a fare, and a way to
book. Forcing one through the other would mean either fabricating geometry or handing the
routing orchestrator something it would treat as a substitutable alternative to a real
road route.

So in the `ride` travel mode, the route on the map comes from the ordinary driving
router, exactly as it would in driving mode. The ride layer sits on top and answers a
different question: who can drive you along it, how soon, and for how much.

The contract lives in
`packages/integration-framework/src/contracts/ride-provider.ts`.

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

`getAvailability` and `createHandoff` are required. Everything else is gated by the
`capabilities` object, and `assertRideProviderContract` throws at setup time if a provider
advertises a capability it does not implement — so a provider that declares
`quote: true` without a `getQuotes` method fails immediately rather than dispatching to
`undefined` on the first real request. The repo-wide conformance test at
`apps/api/src/services/__tests__/provider-contract-conformance.test.ts` runs that
assertion against every integration's real `setup()`.

## `coverageChecked`: say what you actually know

`RideAvailability.coverageChecked` is not decoration. A provider that cannot verify
service at a coordinate must report `false`, and the panel then tells the user that
availability was not checked rather than implying the service is there.

- `integrations/ride-deeplink` sets `false`. It is a URL builder with no network access;
  it has no idea whether Uber operates where you are standing.
- `integrations/ride-gofs` sets `true`. It has the feed's actual service-area polygons and
  operating calendars, and does point-in-polygon against them.

Claiming a coverage check you did not perform is the one thing that makes this field
worse than useless.

## `permitsComparison`: the provider's terms, not the operator's preference

Several ride-hailing vendors' API terms forbid presenting them in an aggregated view
alongside competitors. `permitsComparison` encodes that, which is why it is a readonly
property of the provider and **not** overridable by configuration.

The operator setting `allowQuoteComparison` unlocks a ranked multi-provider list. Even
when it is on, the orchestrator drops any provider whose `permitsComparison` is `false`
before dispatching, and the panel keeps those providers as separate chips below the list.

Before setting this `true` on a new provider, read that vendor's terms. GOFS feeds set it
true because GOFS exists so third-party trip planners can present the service alongside
others — comparison is the intended use, not a tolerated one.

## Fare basis

`RideFare.basis` is either `quoted` or `estimated`.

- `quoted` means the provider returned this number for this trip.
- `estimated` means we computed it locally from a published tariff and the driving
  route's distance and duration.

An estimate is always labelled as one in the UI. If you cannot produce either, omit the
fare entirely and return the ETA on its own — that is a perfectly good answer, and it is
what the Freebee feed yields today.

## Quote lifetime

Quotes are short-lived by contract. The orchestrator stamps `expiresAt` from the
provider's `quoteTtlSeconds` (default 60), overriding whatever the provider returned, so
no provider can leave a stale price on screen by claiming a distant expiry. Providers
should still set their own floor for the case where they are used outside the
orchestrator.

Quotes are never written to `ctx.cache`, never logged, and never persisted. Only a feed's
static files are cached, and only for the lifetime the feed itself declares.

## Personal data

Pickup and dropoff coordinates are personal data, and a quote request is the first place
in OpenMapX where a user's precise origin *and* destination leave the deployment together
for a commercial third party. So:

- Never log coordinates. The orchestrator logs the provider id, the method and a reason
  string, nothing else.
- Never write a quote, a fare, a rider identity, a driver identity, vehicle details or a
  driver location to `ctx.cache` or the database.
- Quote responses carry `Cache-Control: no-store`.

## A worked example: `integrations/ride-gofs`

GOFS — the General On-Demand Feed Specification — is MobilityData's open standard for
demand-responsive transport. It is the one path to real fares and real ETAs with no
partner approval, so it is worth reading as the reference implementation.

**Discovery.** A feed publishes a discovery document listing its other files. Note two
traps: the document is often served at a bare base URL (`https://api.example.com/gofs/11`)
rather than a path ending in `gofs.json`, and its feed list lives inside a mandatory BCP-47
language container (`data.en.feeds`) even though the prose reference shows a flat
`data.feeds`. The parser accepts both.

**Static files, TTL-cached.** `system_information`, `service_brands`, `zones`,
`operating_rules`, `calendars`, `fares`, `booking_rules` and `vehicle_types` are fetched
once and cached for the feed-declared `ttl`. A `ttl` of `0` means *always refresh* and
must not be floored into a positive lifetime.

**Availability.** Point-in-polygon of the pickup (and dropoff, when known) against
`zones`, then `operating_rules` matched against `calendars` and the requested wall-clock
time in the feed's own timezone. The surviving rules' `service_brands` become the
products, and their `vehicle_type_id` list supplies seats and wheelchair accessibility.

**Quotes.** `realtime_booking` is preferred and yields `basis: "quoted"`. Where a feed does
not publish it, `wait_time` supplies the ETA and a local `fares.json` computation supplies
`basis: "estimated"`. Fare tiers honour their `interval`, which rounds up — the spec's own
example is "3.30 CAD per kilometer, charged every 250 meters", and ignoring the interval
undercharges every trip that does not land on a boundary.

**Handoff.** `booking_detail.web_uri`, falling back to `booking_rules.booking_url`, then
the system URL, then a phone number. GOFS specifies the deep-link query parameters, and
`pickup_time` among them is Unix epoch seconds rather than a wall-clock string.

**Feed shapes vary.** The live feeds do not all match the prose reference: calendar dates
arrive as `YYYYMMDD`, pickup windows as `HH:MM:SS`, brand colours without a leading `#`,
and wait times scoped by zone pair rather than by brand. `packages/mobility-formats/gofs.ts`
normalises all of these, with the reasoning recorded in comments beside each helper.

## Adding a keyed provider

Declare the credential in `configSchema` with `x-openmapx-secret: true` and an
`x-openmapx-setup` guide, then read it back from `ctx.config["<sourceId>-<field>"]` — the
vault hands it over decrypted, the same path `ev-charging` uses for `ocm-api-key`. Saving
a credential in the admin panel reloads the integration, so a new key takes effect without
a restart. Register nothing when the credential is absent.

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

**What it is.** The Transport Operator to MaaS Provider API — Apache-2.0, an open standard
for operator-to-MaaS communication. Latest release at the time of writing is Dragonfly
1.6.0; re-check before implementing.

**Why it is second, not first.** TOMP requires an operator to implement and expose it, and
its trip-execution flow presumes a booking relationship OpenMapX does not have. GOFS ships
first because its producers publish specifically to be consumed by third-party trip
planners.

**The mapping.** TOMP's planning/offers stage maps onto `getQuotes` (a TOMP offer becomes a
`RideQuote`, its fare becomes a `RideFare` with `basis: "quoted"`); its booking stage maps
onto `book`; its execution and leg-status stage maps onto `getBooking`; after-sales
cancellation maps onto `cancelBooking`. TOMP therefore exercises the whole contract, which
is why the fake provider in `ride-booking-contract.test.ts` is shaped the way it is.

**What already exists.** `packages/mobility-formats-tomp` holds OpenAPI validation and SDK
generation tooling, not a runtime client. Whether to generate an SDK or hand-write a client
is an open decision; note that a generated SDK drags the TypeScript compiler into the
dependency graph, which is exactly why TOMP has its own package rather than living in
`packages/mobility-formats`.

**The open question.** TOMP operators authenticate per-operator, so a TOMP ride integration
is one provider per configured operator endpoint — the same operator-configured-list shape
`ride-gofs` uses, not a single global provider.
