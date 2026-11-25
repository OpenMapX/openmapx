---
impacts: [breaking, operator-action]
---

## What changes

Every name the web app gives to state it keeps in the browser now follows one
convention: Web Storage keys and IndexedDB records are
`openmapx:<area>:<name>` with kebab-case segments (for example
`openmapx:settings:unit-system`, `openmapx:navigation:3d`), and the IndexedDB
databases and service-worker caches are `openmapx:<name>` (for example
`openmapx:key-value`, `openmapx:offline-packages`, `openmapx:map-tiles`). The
history-state entry is `openmapx:history:entry`. All of them are declared in
one registry in `@openmapx/core`, which also says which preferences the
privacy device export copies and which state is cleared at sign-out.

The privacy device export (`version: 1`) writes these new key names as the
keys of `preferences`, and now also includes the 3D navigation, globe
lighting, search-history and cycling preferences. The persisted query cache is
invalidated by a plain schema number, and the offline saved-places mirror
record carries `version: 1`.

Shareable map URLs use full lowerCamel parameter names and write every
boolean as `1` or `0`. The renamed parameters are: `ov` → `overlay`, `base` →
`baseLayer`, `at` → `placeLocation`, `name` → `placeName`, `cat` →
`placeCategory`, `raw` → `placeRawCategory`, `stop` → `placeTransitStop`,
`wp` → `waypoint`, `sched` → `schedule`, `categoryId` → `category`, `bbox` →
`bounds`, `source` → `dataSource`, `item` → `dataSourceItem`, `list` →
`savedList`, `measure` → `measurement`, `measureUnit` → `measurementUnits`,
`measurePts` → `measurementPoints`, `measureDone` → `measurementFinished`,
`iso` → `travelTime`, `isoAt` → `travelTimeOrigin`, `isoMins` →
`travelTimeMinutes`, `sat`/`date`/`opacity` → `satelliteLayer`/
`satelliteDate`/`satelliteOpacity`, `eq` → `earthquakes`, `fire` →
`wildfires`, `neDays`/`neCat` → `naturalEventDays`/`naturalEventCategories`,
`alertSev` → `weatherAlertSeverities`, `envSensor` → `environmentSensor`,
`sli` → `streetLevelImage`, `trail` → `hikingTrail`, `winter` →
`winterSportsFeature`, `cycleAuto` → `cyclingAutomatic`, `ltProviders`/
`ltModes`/`ltCodes`/`ltVehicle` → `liveTransitExcludedProviders`/
`liveTransitExcludedModes`/`liveTransitExcludedCodespaces`/
`liveTransitVehicle`. The cycling preferences `bikePreferQuietRoads` and
`bikePreferSmoothSurfaces` are written `1`/`0` instead of `true`/`false`.
The share-target and native search intent is `query` (was `q`) and the return
from an OpenStreetMap sign-in is `osmContribution` (was `osm-contribute`).
`map`, `panel`, `place`, `mode`, `avoid`, `search`, `savedTab`, `globe`,
`buildings`, `weather` and the other `bike…` names are unchanged; the unused
`units` parameter is gone. The parameter names are declared once in
`@openmapx/core/map-link-params`, which the web app and the native app share.

Crowd reporting changes on both the client and the relay:

- The reporting identity is a non-extractable P-256 `CryptoKeyPair` in
  IndexedDB (database `openmapx:crowd`, record `openmapx:crowd:device-key`,
  shape `{ version: 1, keyId, keyPair }`, where `keyId` is the RFC 7638
  thumbprint of the public key). No script on the origin can read the private
  key. The cached reporting grant (`openmapx:crowd:grant`) names the `keyId` it
  was issued for and is used only with that key.
- Every signed report and vote body carries `"v": 1` inside the signed bytes.
  This needs the OpenConditions release that requires it.
- `api` sends `Authorization: Bearer <OPENCONDITIONS_RELAY_TOKEN>` on every
  request it relays to contributions-api, and limits each client address in two
  buckets of its own: 30 reports, votes and token requests a minute, and 10
  enrollments a minute, the same as contributions-api's default direct limit.
  The client's address is still never forwarded. A set token shorter
  than 32 characters stops the `crowd-reports` integration from starting.

## Who is affected

Browsers that used an earlier development build keep their old keys, which
this release no longer reads: preferences, the local garage and parked cars,
recent searches, offline map packages and cached map data start empty again.
Map links copied from a development build open only the camera position and
lose the place, route, search or overlay they named. No public release has
used the old names.

Installations that offer crowd reports through the OpenConditions extension.
A browser that reported with a development build gets a new reporting identity.

## Required action

None. A browser that used a development build can clear the site data for
the OpenMapX origin to remove the unused old entries; downloaded offline map
packages need to be downloaded again. Links shared from a development build
need to be shared again.

With crowd reports: generate one token (`openssl rand -hex 32`), set it as
`OPENCONDITIONS_RELAY_TOKEN` in `infra/docker/.env` and as the same setting of
the contributions-api service, apply the contributions-api service and run
`pnpm openmapx services start api`. Upgrade OpenConditions together with
OpenMapX: a contributions-api that does not know `"v": 1` refuses the new
claims, and one that requires it refuses claims from an older OpenMapX.
