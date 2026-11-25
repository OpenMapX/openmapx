---
impacts: [breaking]
---

## What changes

The installed mobile app now names the protocol it speaks on every API request
it makes without a WebView (car search and route planning, rerouting, voice
references, transit refresh and journey captures), in the
`X-OpenMapX-Mobile-Protocol` header. The API answers a request whose header
names a protocol outside the range it serves with `426` and
`{ "error": "...", "code": "MOBILE_PROTOCOL_UNSUPPORTED" }`, before any route
runs. Requests without the header, such as the web app's, are not affected.
The app shows "update required" in the car and in its navigation notification
when it receives that answer.

The protocol numbering starts again at 1: the bridge between the web page and
the app, and the native API routes, both speak version 1. The six native API
operations are declared as one contract family in `@openmapx/core` (geocode,
directions, route match, navigation landmarks, transit plan refresh and vehicle
journey), and a committed digest of that family must change together with the
protocol number.

The app's on-device navigation database starts from one version-1 schema. It
no longer carries the pre-release migration history, the car destinations
table is part of that schema, and the feasibility probe's table exists only in
feasibility builds.

## Who is affected

Development and test builds of the mobile app made before this release. No
store build has been published.

## Required action

Uninstall development builds of the mobile app made before this release and
install a build from this release. A self-hosted page or API from this release
asks an older build for an update.
