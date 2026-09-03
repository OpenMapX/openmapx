---
title: Personal timeline
description: Connect a Dawarich account and view a read-only day timeline inside OpenMapX.
sidebar_position: 18
---

# Personal timeline

Personal Timeline adds an opt-in **Your timeline** view to OpenMapX. It reads one
day at a time from [Dawarich](https://dawarich.app/) and presents visits,
journeys, summary values, bounds, and available track geometry on the OpenMapX
map. OpenMapX does not track, import, edit, or delete locations through this
feature. Location collection and all writes continue to happen directly in
Dawarich through its own apps and import methods.

An OpenMapX account is required because each connection belongs to one user.
The feature supports one active connection at a time. Switching mode replaces
that connection only after the new source and credential validate successfully.

For information on self-hosting Dawarich and configuring mobile tracking apps or
Google Takeout imports, see [Self-hosting location history (Dawarich)](../guides/dawarich.md).

## Connect an external Dawarich instance

1. Open account settings in OpenMapX and find **Personal Timeline**.
2. Choose **External instance**.
3. Enter the instance's public HTTPS origin, for example
   `https://timeline.example.org`. Paths, credentials, query strings, fragments,
   plain HTTP, and private-network targets are rejected unless the OpenMapX
   operator explicitly allowlists that private hostname.
4. In Dawarich, open **Account settings** at `/users/edit`, create or copy your
   personal API key, and paste it into OpenMapX.
5. Select **Connect**. OpenMapX checks the current-user, settings, and timeline
   API contracts before replacing any existing connection.

The OpenMapX backend, not the browser, calls the selected Dawarich API. The
instance operator can therefore see requests from the OpenMapX server and
governs that instance's accounts, location data, retention, and availability.

## Use managed Dawarich

If the OpenMapX operator installed, provisioned, enabled, and health-checked the
optional managed bundle, account settings offer **Managed Dawarich**. Open the
managed account page, sign in through OpenMapX, then copy the personal API key
from `https://timeline.<openmapx-domain>/users/edit` and connect it in OpenMapX.

The two credentials have different jobs:

- Better Auth OIDC provides browser single sign-on to the Dawarich website. It
  sends the managed instance your stable account identifier (`sub`), name, and
  email. Dawarich maintains a separate browser session; signing out of OpenMapX
  is not single logout.
- The personal Dawarich API key authorizes OpenMapX's server-side, read-only API
  calls. Dawarich 1.10.3 does not let the OIDC browser session or Better Auth
  token replace this key.

If a pre-existing Dawarich account has the same email, Dawarich requires its
explicit account-linking challenge. OpenMapX never silently links it. Keep a
verified local Dawarich administrator as a recovery login until SSO and linking
have been tested.

## Days, time zones, and partial geometry

A calendar date is interpreted in the time zone reported by Dawarich. OpenMapX
computes that local day's exact UTC interval, including 23- and 25-hour daylight
saving transitions, and requests only that interval. Dates and timeline payloads
are not placed in shared or persistent caches.

The timeline summary and entries are required. Track geometry is optional and
fetched under bounded page and feature limits. If later track pages fail or the
limit is reached, OpenMapX keeps already validated geometry, marks the result as
partial, and shows a warning. It never invents missing geometry. An invalid core
timeline response fails the whole day.

## Errors and recovery

| Message/code | Meaning | What to do |
| --- | --- | --- |
| `TIMELINE_NOT_CONNECTED` | No connection exists. | Connect an instance in account settings. |
| `TIMELINE_MANAGED_DISABLED` | Managed Dawarich is disabled, unprovisioned, or unhealthy. | Wait for the operator to recover it; do not reconnect or repaste the key. |
| `TIMELINE_CREDENTIAL_INVALID` | Dawarich rejected the API key. | Create/copy the key at `/users/edit`, then reconnect. |
| `TIMELINE_RATE_LIMITED` | The source asked OpenMapX to slow down. | Retry after the indicated delay. |
| `TIMELINE_UPSTREAM_UNAVAILABLE` | Network or source service is unavailable. | Retry later; repeated transient failures may mark the connection degraded. |
| `TIMELINE_INSTANCE_UNSUPPORTED` | The origin or required Dawarich API is unsupported. | Correct the URL or update the instance. |
| `TIMELINE_PLAN_RESTRICTED` | The Dawarich account/plan denied an endpoint. | Review the account on that instance. |
| `TIMELINE_RESPONSE_INVALID` | The source returned data outside the supported contract. | Check the supported Dawarich version and operator logs. |

Disabling managed Dawarich does not delete the OpenMapX connection or Dawarich
volumes. After the operator re-enables and recovers the same service, the stored
encrypted key works again without reconnecting.

## Storage, privacy, and disconnect

OpenMapX stores the public origin, display metadata, validated timezone and
distance unit, connection status, and the API key encrypted at rest. It does not
return the key after connection. Fetched history is transient: it is excluded
from PostgreSQL timeline storage, Redis/shared caches, the Service Worker,
persisted query caches, logs, audit details, analytics, and metric labels.

Disconnect deletes the OpenMapX connection and encrypted credential. Deleting
the OpenMapX account does the same through database cascade. Neither action
deletes data held by Dawarich. Use the direct Dawarich account settings and the
instance operator's deletion/export processes for that data. A managed service
disable preserves volumes; purge is a separate, explicitly confirmed operator
operation.

## Future authorization

The manual API-key step is a versioned v1 boundary. If a future supported
Dawarich release exposes OAuth/JWT authorization for these read endpoints,
OpenMapX can add a deliberate migration and reauthorization flow. It will not
infer API authorization from a browser session or silently change existing
credentials.

Operators should also read [Self-hosting location history (Dawarich)](../guides/dawarich.md)
for provisioning, DNS/TLS, health, backup, restore, release, and purge controls.
