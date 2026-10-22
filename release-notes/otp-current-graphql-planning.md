---
impacts: [breaking, operator-action]
---

## What changes

The self-hosted OpenTripPlanner integration now uses OTP 2.10's GTFS GraphQL
`planConnection` API. Removed REST endpoints and OTP 1 response formats are no
longer supported. Departure and arrival timestamps retain their timezone offsets.
Upstream, policy and invalid-response failures are reported as failures rather
than successful empty journey results. Itinerary counts must be integers from
1 to 50; locations and timestamps must be valid.

## Who is affected

Operators using the self-hosted OTP integration, including custom endpoint URLs.

## Required action

Use OTP 2.10 with the GTFS GraphQL API enabled at `/otp/gtfs/v1`. Configure the
server's base URL, without credentials, query parameters or a fragment. The
managed OTP image and graph-build workflow are unchanged. No migration or
compatibility mode is provided. Generated clients are checked offline; no public
provider credentials or Redis quota store are needed for this self-hosted service.
