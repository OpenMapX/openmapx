---
title: Crowd reports
description: Submit and verify pseudonymous live road conditions through OpenConditions.
sidebar_position: 12
---

# Crowd reports

Use **Report a condition** in the map controls to report a road closure, lane
closure, crash, stopped vehicle, hazard, congestion, roadworks, or another road
condition. Reports need a reachable OpenConditions contributions service; an
OpenMapX account is not required.

1. Open **Report a condition**.
2. Choose the category and check the location. Use your current location, the
   map center, or a point selected on the mini-map.
3. Choose the extent: here, ahead, back of the queue, or all along the stretch.
   Adjust severity if needed.
4. Submit and wait for the result. If submission fails, the condition has not
   been confirmed as accepted; retry when the service is available.

During navigation, compatible reports ahead appear as approach prompts. A
traveler can confirm that a condition is still present or negate it when it has
cleared. Verified road events then appear with official-feed conditions in the
[road-conditions layer](./map-layers.md) and can participate in routing policy
when the OpenConditions service considers them trustworthy enough.

## Privacy and trust model

Reports and votes are pseudonymous and are not bound to an OpenMapX login. The
browser creates a device key, enrolls it for short-lived reporting grants, and
signs each claim locally. OpenMapX relays the signed envelope unchanged; the
OpenConditions contributions service verifies signatures and decides how
evidence, votes, and official feeds affect trust. Clearing site storage creates a new reporting identity. Pseudonymity does not
hide the reported location or stop the server and contributions service from
processing request metadata.

## Operator setup

The built-in `crowd-reports` integration supplies the UI and relay routes and is
enabled by default, but submitting reports requires a compatible self-hosted
OpenConditions contributions service. Install the OpenConditions extension (or
another compatible service) and set its endpoint for `api`:

```bash
OPENCONDITIONS_CONTRIBUTIONS_URL=http://openmapx-openconditions-contributions-api:4200
OPENCONDITIONS_RELAY_TOKEN=<the same value as contributions-api's OPENCONDITIONS_RELAY_TOKEN>
```

This example uses the contributions service's container hostname. Ensure
`api` can resolve and reach it on the deployment network. A host-run API
needs an endpoint reachable from that host.

`api` sends the relay token (at least 32 characters, for example from
`openssl rand -hex 32`) as a bearer token on every relayed request.
contributions-api then counts those requests in its relay bucket instead of
limiting every reporter as the one address of `api`. `api` never forwards the
reporter's address; it limits each client address itself, in two buckets of
its own. Both are token buckets that start full and refill continuously: 30
reports, votes and token exchanges, refilled at 30 a minute, and 10
enrollments, refilled at 10 a minute. The enrollment bucket works like
contributions-api's default enrollment limit for one address, so a client can
enroll a burst of 10 and then one every six seconds either way. Browsing place
details never uses up the reporting budget. Without the
token, all reporters share contributions-api's per-address enrollment limit.

If the two token values differ, contributions-api treats every relayed request
as coming from the one address of `api`, and neither side reports it: reporting
works, but enrollment for the whole instance stops at contributions-api's
per-address limit. When enrollments start failing with `429` under ordinary
use, compare the value in `infra/docker/.env` with the one in the
contributions-api Credentials.

The reporting identity is a non-extractable P-256 key pair in the browser's
IndexedDB (database `openmapx:crowd`); its reporting grant is cached in
`localStorage` under `openmapx:crowd:grant`, together with the key id it was
issued for. Every signed report and vote carries `"v": 1`, the signed claim
protocol version.

The development fallback is `http://localhost:4200`, the contributions
service's default port; without a reachable
service, report enrollment and submission return an unavailable error. The API
also briefly caches the service's public issuer keys. See [Community
extensions](../administration/community-extensions.md) for installing a bundled
integration/service extension and [Building an external
extension](../developer/building-an-external-extension.md) for the packaging
model.

## Related features

- [Directions & navigation](./directions.md): approach prompts and live routing.
- [Map layers](./map-layers.md): display trusted crowd and official conditions.
