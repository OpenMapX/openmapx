---
impacts: [operator-action]
---

## What changes

Installed OpenMapX apps can show ongoing ground and transit guidance through an
Android navigation notification or an iOS Live Activity, with session-bound native
End confirmation. The cards follow the durable native session and do not require
an active WebView. Availability, promotion, privacy and background updates remain
subject to OS permissions and runtime policies.

The iOS shell adopts Expo's scene lifecycle for iOS 27 SDK builds. Fractional
GPS timestamps are normalized before persistence so an iOS location update does
not invalidate and clear the running trip.

## Who is affected

Operators who build or distribute OpenMapX's native Android and iOS apps,
including self-hosted apps with their own bundle identifiers.

## Required action

Ship the updated web app and rebuilt native binaries together so native End also
clears the web guidance screen. Android requests the non-runtime
POST_PROMOTED_NOTIFICATIONS permission. Apple distribution additionally requires
registering/provisioning the derived `.NavigationSurface` extension App ID; no
remote push entitlement or service is required.
