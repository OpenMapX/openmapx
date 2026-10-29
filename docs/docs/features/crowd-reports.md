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
another compatible service) and set its endpoint for `app-api`:

```bash
OPENCONDITIONS_CONTRIBUTIONS_URL=http://openconditions-contributions-api:4200
```

This example uses the contributions service's container hostname. Ensure
`app-api` can resolve and reach it on the deployment network. A host-run API
needs an endpoint reachable from that host.

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
