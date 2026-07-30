---
title: Crowd reports
description: Submit and verify pseudonymous live road, transit, micromobility, and accessibility conditions through OpenConditions.
sidebar_position: 12
---

# Crowd reports

OpenMapX can collect fresh, on-the-ground conditions without tying them to an
account. From the map or during navigation, a person can report a road or lane
closure, crash, stopped vehicle, object/weather/animal hazard, congestion,
roadworks, transit disruption, micromobility issue, accessibility issue, or an
uncategorized condition.

The report flow captures three useful signals:

- **Where it applies** — current location, map center, or a point picked on a
  mini-map.
- **How precise it is** — here, somewhere ahead, back of the queue, or all along
  this stretch. This becomes explicit spatial fuzziness rather than false
  precision.
- **Severity** — level 1–5, preselected by category and still adjustable.

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
evidence, votes, and official feeds affect trust. Treat the local device key as
browser data: clearing site storage creates a new reporting identity.

## Operator setup

The built-in `crowd-reports` integration supplies the UI and relay routes and is
enabled by default, but submitting reports requires a compatible self-hosted
OpenConditions contributions service. Install the OpenConditions extension (or
another compatible service) and set its endpoint for `app-api`:

```bash
OPENCONDITIONS_CONTRIBUTIONS_URL=http://openconditions:3002
```

The development fallback is `http://localhost:3002`; without a reachable
service, report enrollment and submission return an unavailable error. The API
also briefly caches the service's public issuer keys. See [Community
extensions](../administration/community-extensions.md) for installing a bundled
integration/service extension and [Building an external
extension](../developer/building-an-external-extension.md) for the packaging
model.

## Related features

- [Directions & navigation](./directions.md) — approach prompts and live routing.
- [Map layers](./map-layers.md) — display trusted crowd and official conditions.
- [Public transit](./public-transit.md) — report transit disruptions.
