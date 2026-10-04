---
title: Crowd reports
description: Submit and verify pseudonymous live road conditions through OpenConditions.
sidebar_position: 12
---

# Crowd reports

OpenMapX can collect fresh, on-the-ground conditions without tying them to an
account. From the map or during navigation, a person can report a road or lane
closure, crash, stopped vehicle, object/weather/animal hazard, congestion,
roadworks, or an uncategorized condition. Each category is sent as an
OpenConditions situation (for example a lane closure is a closure that restricts
some lanes, a jam is a queue), so crowd reports and official feeds describe the
same situation the same way.

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
OPENCONDITIONS_CONTRIBUTIONS_URL=http://openconditions-contributions-api:4200
```

`openconditions-contributions-api` is the OpenConditions contributions
service's name on its network, which `app-api` joins.

The development fallback is `http://localhost:4200`, the contributions
service's default port; without a reachable
service, report enrollment and submission return an unavailable error. The API
also briefly caches the service's public issuer keys. See [Community
extensions](../administration/community-extensions.md) for installing a bundled
integration/service extension and [Building an external
extension](../developer/building-an-external-extension.md) for the packaging
model.

## Related features

- [Directions & navigation](./directions.md) — approach prompts and live routing.
- [Map layers](./map-layers.md) — display trusted crowd and official conditions.
